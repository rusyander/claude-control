import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { defaultOurRules, defaultPlatformRules } from '@agentdeck/contracts/platform';
import { defaultPlatformTransport } from '@agentdeck/contracts/platform-transport';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { Platform } from '@agentdeck/contracts';
import { AppStore } from '../../../lib/app-store.ts';
import { saveRules } from '../../dlp/rules-store.ts';
import { writePlatform, writeToken } from '../store.ts';
import type { PlatformFetch } from '../ca-fetch.ts';
import { PlatformGateway } from './listener.ts';

/**
 * Ручка картинок контура через шлюз (решение владельца 17.09.2026): настоящий
 * слушатель и настоящий HTTP, подменён только контур.
 *
 * До этого маршрута панель рисовала ручкой контура напрямую — без следа, расхода,
 * перевода отказов и защиты данных. Здесь каждое из четырёх обещаний проверено
 * на сокете, плюс то, чем маршрут отличается от чата: повтора платной картинки
 * нет.
 */

const SECRET = 'platform-token-images-7c1e';
const PNG_B64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

const PLATFORM: Platform = {
  id: 'enterprise-platform',
  title: 'Company · dev',
  driver: 'enterprise-platform',
  baseUrl: 'https://api.dev.example.ru',
  enabled: true,
  mode: 'required',
  budgetUsd: 0,
  capabilities: [],
  targets: [],
  projectPaths: [],
  consumers: [],
  agents: [],
  budgetSince: '',
  toolShim: true,
  contourPrompt: true,
  defaultModel: '',
  consumerModels: {},
  modelMap: {},
  rules: { platform: defaultPlatformRules(), ours: defaultOurRules() },
  caCertPath: '',
  transport: defaultPlatformTransport(),
  manifest: { imagesApi: 'images/generations' },
};

let root: string;
let appData: string;
let store: AppStore;
let gateway: PlatformGateway;
let port = 0;
let calls: { url: string; headers: Record<string, string>; body: string }[] = [];

function contour(status: number, payload: unknown): PlatformFetch {
  return (url, init) => {
    calls.push({
      url,
      headers: (init?.headers ?? {}) as Record<string, string>,
      body: init?.body ?? '',
    });
    return Promise.resolve(
      new Response(JSON.stringify(payload), {
        status,
        headers: { 'content-type': 'application/json' },
      }),
    );
  };
}

async function start(fetchImpl: PlatformFetch): Promise<void> {
  await gateway.start({ store, appDataDir: appData, port: 0, fetchImpl, spendFlushMs: 0 });
  port = gateway.status().port;
}

async function draw(body: unknown): Promise<{ status: number; text: string }> {
  const response = await fetch(
    `http://127.0.0.1:${port}/enterprise-platform/v1/images/generations`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    },
  );
  return { status: response.status, text: await response.text() };
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'cc-gateway-images-'));
  appData = join(root, 'agentdeck');
  mkdirSync(appData, { recursive: true });
  store = new AppStore(appData);
  writePlatform(store, PLATFORM);
  writeToken(appData, PLATFORM.id, SECRET);
  gateway = new PlatformGateway();
  calls = [];
});

afterEach(async () => {
  await gateway.stop();
  rmSync(root, { recursive: true, force: true });
});

describe('шлюз: ручка картинок контура', () => {
  it('маршрут назван в адресах контура', async () => {
    await start(contour(200, {}));
    expect(gateway.status().routes[0]?.paths).toContain('/v1/images/generations');
  });

  it('байты — клиенту как есть, ключ — шлюзом, в след — размер и «расход не сообщён»', async () => {
    await start(contour(200, { created: 1, data: [{ b64_json: PNG_B64 }] }));
    const answer = await draw({ model: 'flux', prompt: 'кот', response_format: 'b64_json' });

    expect(answer.status).toBe(200);
    expect(JSON.parse(answer.text)).toEqual({ created: 1, data: [{ b64_json: PNG_B64 }] });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url.endsWith('/v1/images/generations')).toBe(true);
    expect(calls[0]?.headers.authorization).toBe(`Bearer ${SECRET}`);
    expect(calls[0]?.headers.accept).toBe('application/json');

    const event = gateway.status().events[0];
    expect(event).toMatchObject({
      path: '/enterprise-platform/v1/images/generations',
      status: 200,
    });
    expect(event?.imageBytes).toBe(Buffer.from(PNG_B64, 'base64').length);
    expect(event?.usageUnreported).toBe(true);
    expect(JSON.stringify(event)).not.toContain(PNG_B64.slice(0, 16));
  });

  it('расход, присланный ручкой, считается', async () => {
    await start(
      contour(200, {
        data: [{ b64_json: PNG_B64 }],
        usage: { input_tokens: 12, output_tokens: 300, total_tokens: 312 },
      }),
    );
    await draw({ prompt: 'кот' });
    const event = gateway.status().events[0];
    expect(event?.totalTokens).toBe(312);
    expect(event?.usageUnreported).toBeUndefined();
  });

  it('503 контура НЕ повторяется: платная картинка — один запрос наверх', async () => {
    await start(contour(503, { error: { message: 'upstream model is unavailable' } }));
    const answer = await draw({ prompt: 'кот' });
    expect(answer.status).toBeGreaterThanOrEqual(500);
    expect(calls).toHaveLength(1);
  });

  it('451 переведён: клиенту своя форма без текста проверки, в следе — отказ проверок', async () => {
    await start(
      contour(451, {
        error: {
          message: 'blocked',
          type: 'guardrail_violation',
          code: 'content_policy_violation',
        },
        violations: [
          {
            rule_id: 'r-pii',
            rule_name: 'Персональные данные',
            rule_type: 'ANONYMIZE',
            message: 'найдено: Иванов Иван',
          },
        ],
      }),
    );
    const answer = await draw({ prompt: 'паспорт' });
    expect(answer.status).toBe(400);
    expect(answer.text).toContain('content_policy_violation');
    expect(answer.text).not.toContain('Иванов');
    const event = gateway.status().events[0];
    expect(event?.blocked).toBe(true);
    expect(event?.violations.length).toBeGreaterThan(0);
  });

  it('защита данных маскирует ПРОМПТ до отправки, а правило «отклонить» не пускает наружу', async () => {
    store.updateSettings({ dlp: { ...store.getSettings().dlp, enabled: true } });
    const rule = {
      id: 'r1',
      name: 'Фамилии сотрудников',
      enabled: true,
      kind: 'terms' as const,
      terms: ['Иванов'],
      pattern: '',
      action: 'mask' as const,
      label: 'ИМЯ',
    };
    saveRules(appData, [rule]);
    await start(contour(200, { data: [{ b64_json: PNG_B64 }] }));

    await draw({ prompt: 'портрет Иванов' });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.body).not.toContain('Иванов');

    saveRules(appData, [{ ...rule, action: 'block' }]);
    const refused = await draw({ prompt: 'портрет Иванов' });
    expect(refused.status).toBe(400);
    expect(refused.text).toContain('Фамилии сотрудников');
    expect(calls).toHaveLength(1);
  });

  it('контур без объявленной ручки — 404 с причиной и без похода наружу', async () => {
    const { manifest: _manifest, ...bare } = PLATFORM;
    writePlatform(store, bare);
    await start(contour(200, {}));
    const answer = await draw({ prompt: 'кот' });
    expect(answer.status).toBe(404);
    expect(answer.text).toContain('ручка картинок');
    expect(calls).toHaveLength(0);
  });
});
