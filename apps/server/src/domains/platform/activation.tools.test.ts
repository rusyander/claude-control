import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { defaultOurRules, defaultPlatformRules } from '@agentdeck/contracts/platform';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { Platform } from '@agentdeck/contracts';
import { AppStore } from '../../lib/app-store.ts';
import type { PlatformFetch } from './ca-fetch.ts';
import { PlatformGateway } from './gateway/listener.ts';
import { activatePlatform, type ContourActivationDeps } from './activation.ts';
import { writePlatform, writeToken } from './store.ts';
import { defaultPlatformTransport } from '@agentdeck/contracts/platform-transport';

/**
 * Проба инструментов (развилка 3) — через НАСТОЯЩИЙ шлюз: перевод поля `tools`
 * в диалект контура живёт там, и только этот путь отвечает, дойдёт ли вызов.
 *
 * Ниже — шапка соседнего теста пробного запроса, её смысл тот же.
 *
 * Пробный запрос активации — через НАСТОЯЩИЙ шлюз: настоящий сокет на петле,
 * настоящий конвейер, подставлен только контур наверху.
 *
 * Ради этого транспорты и разведены (`probeFetch` / `smokeFetch`): заглушка,
 * подставленная обоим, доказывала бы работу заглушки. Здесь же запрос выходит
 * из домена в сеть, возвращается в свой же слушатель, проходит перевод диалекта
 * и подстановку ключа — то есть ровно тот путь, которым пойдёт CLI, и ни одним
 * звеном короче.
 */

const SECRET = 'contour-key-corporate-4f21';

const PLATFORM: Platform = {
  id: 'enterprise-platform',
  title: 'Company · dev',
  driver: 'openai-compat',
  baseUrl: 'https://api.dev.example.ru',
  enabled: false,
  mode: 'required',
  budgetUsd: 0,
  capabilities: [],
  targets: [],
  projectPaths: [],
  consumers: [],
  agents: [],
  budgetSince: '',
  toolShim: false,
  contourPrompt: true,
  defaultModel: '',
  consumerModels: {},
  modelMap: {},
  rules: { platform: defaultPlatformRules(), ours: defaultOurRules() },
  caCertPath: '',
  transport: defaultPlatformTransport(),
};

/** Проба: список моделей прямо из контура, мимо шлюза. */
const modelsOk: PlatformFetch = () =>
  Promise.resolve(
    new Response(JSON.stringify({ data: [{ id: 'gpt-x' }] }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }),
  );

let root: string;
let appData: string;
let store: AppStore;
let gateway: PlatformGateway;
/** Куда и с чем шлюз сходил наверх: адрес, заголовки, тело. */
let calls: { url: string; headers: Record<string, string>; body: string }[] = [];

/** Контур-заглушка НАД шлюзом: N-му запросу отвечает N-м набором кадров потоком (последний — всем дальше). */
function sequence(answers: string[][], status = 200): PlatformFetch {
  return (url, init) => {
    const frames = answers[Math.min(calls.length, answers.length - 1)] ?? [];
    calls.push({
      url,
      headers: (init?.headers ?? {}) as Record<string, string>,
      body: typeof init?.body === 'string' ? init.body : '',
    });
    if (status >= 400) {
      return Promise.resolve(
        new Response(frames.join(''), {
          status,
          headers: { 'content-type': 'application/json' },
        }),
      );
    }
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        const encoder = new TextEncoder();
        for (const frame of frames) controller.enqueue(encoder.encode(`data: ${frame}\n\n`));
        controller.close();
      },
    });
    return Promise.resolve(
      new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } }),
    );
  };
}

const DELTA = '{"id":"c1","model":"gpt-x","choices":[{"index":0,"delta":{"content":"готов"}}]}';
const DONE = '{"id":"c1","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}';

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'cc-activation-gw-'));
  appData = join(root, 'agentdeck');
  mkdirSync(appData, { recursive: true });
  mkdirSync(join(root, 'claude'), { recursive: true });
  calls = [];

  store = new AppStore(appData);
  writePlatform(store, PLATFORM);
  writeToken(appData, PLATFORM.id, SECRET);
  gateway = new PlatformGateway();
});

afterEach(async () => {
  await gateway.stop();
  rmSync(root, { recursive: true, force: true });
});

const deps = (): ContourActivationDeps => ({
  store,
  paths: { claudeSettings: join(root, 'claude', 'settings.json') },
  backupDir: join(root, 'backups'),
  appDataDir: appData,
  probeFetch: modelsOk,
  // Порт — у ЖИВОГО слушателя, ровно как его берёт маршрут: порт 0 при старте
  // означает «какой достанется», и спросить его можно только у него самого.
  gatewayPort: () => (gateway.status().running ? gateway.status().port : 0),
  // `smokeFetch` не задан НАМЕРЕННО: пробный запрос идёт настоящим `fetch` в
  // настоящий слушатель на 127.0.0.1.
});

const CALL =
  '{"id":"c2","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"t1","type":"function","function":{"name":"report_status","arguments":"{\\"status\\":\\"ready\\"}"}}]}}]}';
const CALL_DONE = '{"id":"c2","choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}]}';
const text = (content: string): string =>
  JSON.stringify({ id: 'c2', choices: [{ index: 0, delta: { content } }] });

async function startWith(fetchImpl: PlatformFetch): Promise<void> {
  await gateway.start({ store, appDataDir: appData, port: 0, fetchImpl, spendFlushMs: 0 });
}

describe('проба инструментов при активации', () => {
  it('модель вызвала инструмент полем — зелёная строка, поле дошло до контура', async () => {
    await startWith(
      sequence([
        [DELTA, DONE],
        [CALL, CALL_DONE],
      ]),
    );
    const result = await activatePlatform(deps(), PLATFORM.id);

    expect(result.smoke.ok).toBe(true);
    expect(result.smoke.tools).toEqual({ ok: true });
    expect(calls).toHaveLength(2);
    expect(JSON.parse(calls[1]?.body ?? '{}').tools?.[0]?.function?.name).toBe('report_status');
    expect(store.getState().platformSmoke?.[PLATFORM.id]?.tools).toEqual({ ok: true });
    // Тот же вызов виден чату чужого CLI: журнал шлюза считает вызовы полем.
    expect(gateway.toolCallsSince(0)).toBe(1);
  });

  it('вызов текстом — причина названа, ничего не исполнено', async () => {
    const asText = '```json\n{"name":"report_status","arguments":{"status":"ready"}}\n```';
    await startWith(
      sequence([
        [DELTA, DONE],
        [text(asText), DONE],
      ]),
    );
    const result = await activatePlatform(deps(), PLATFORM.id);

    expect(result.smoke.ok).toBe(true);
    expect(result.smoke.tools).toMatchObject({ ok: false, reason: 'call-as-text' });
  });

  it('ответ без вызова — «не вызвала»', async () => {
    await startWith(
      sequence([
        [DELTA, DONE],
        [text('Готово.'), DONE],
      ]),
    );
    const result = await activatePlatform(deps(), PLATFORM.id);
    expect(result.smoke.tools).toMatchObject({ ok: false, reason: 'no-call' });
  });

  it('прослойка включена — не спрашиваем: один запрос наверх', async () => {
    writePlatform(store, { ...PLATFORM, toolShim: true });
    await startWith(sequence([[DELTA, DONE]]));
    const result = await activatePlatform(deps(), PLATFORM.id);
    expect(result.smoke.tools).toBeUndefined();
    expect(calls).toHaveLength(1);
  });

  it('тип контура выбрасывает поле — «dropped» без похода в сеть', async () => {
    writePlatform(store, { ...PLATFORM, driver: 'enterprise-platform' });
    await startWith(sequence([[DELTA, DONE]]));
    const result = await activatePlatform(deps(), PLATFORM.id);
    expect(result.smoke.tools).toMatchObject({ ok: false, reason: 'dropped' });
    expect(calls).toHaveLength(1);
  });
});
