import { writeFileSync } from 'node:fs';
import { rulesPath } from '@agentdeck/dlp/rules-file';
import type { RouteReply, RouteRequest } from '@agentdeck/stub-model';
import { afterEach, describe, expect, it } from 'vitest';
import {
  CONTOUR_KEY,
  userGatewayStand,
  type UserGatewayStand,
} from './__fixtures__/user-gateway-stand.ts';

/**
 * Ручка картинок контура через шлюз человека ядра — случаи `pipeline.images.integration.test.ts`
 * панели на настоящем пути: `state.json` панели (манифест `imagesApi`) → `readPanelProfiles` →
 * `userRouteOf` → хост звеньев → контур (заглушка `packages/stub-model`). Чем ручка отличается от
 * разговора: повтора платной картинки нет, байты — клиенту как есть, маска — на промпте.
 * Строка дня панели (`unreportedAnswers`) — учёт панели, не звена; звено говорит то же следом.
 */

const PNG_B64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const MANIFEST = { manifest: { imagesApi: 'images/generations' } };

let gw: UserGatewayStand | undefined;
let calls: RouteRequest[] = [];
afterEach(async () => {
  await gw?.close();
  gw = undefined;
  calls = [];
});

function contour(
  status: number,
  payload: unknown,
): (request: RouteRequest) => RouteReply | undefined {
  return (request) => {
    if (!request.path.endsWith('/images/generations')) return undefined;
    calls.push(request);
    return { status, body: payload };
  };
}

async function draw(body: unknown): Promise<{ status: number; text: string }> {
  const response = await fetch(`http://127.0.0.1:${gw!.port}/corp/v1/images/generations`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: response.status, text: await response.text() };
}

const RULE = {
  id: 'r1',
  name: 'Фамилии сотрудников',
  enabled: true,
  kind: 'terms' as const,
  terms: ['Иванов'],
  pattern: '',
  action: 'mask' as const,
  label: 'ИМЯ',
};

describe('шлюз человека: ручка картинок контура', () => {
  it('байты — клиенту как есть, ключ — звеном, в след — размер и «расход не сообщён»', async () => {
    gw = await userGatewayStand(MANIFEST, {
      reply: contour(200, { created: 1, data: [{ b64_json: PNG_B64 }] }),
    });
    const answer = await draw({ model: 'flux', prompt: 'кот', response_format: 'b64_json' });

    expect(answer.status).toBe(200);
    expect(JSON.parse(answer.text)).toEqual({ created: 1, data: [{ b64_json: PNG_B64 }] });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.path.endsWith('/v1/images/generations')).toBe(true);
    expect(calls[0]?.headers.authorization).toBe(`Bearer ${CONTOUR_KEY}`);
    expect(calls[0]?.headers.accept).toBe('application/json');

    const event = gw.trace().at(-1);
    expect(event).toMatchObject({ path: '/v1/images/generations', status: 200 });
    expect(event?.imageBytes).toBe(Buffer.from(PNG_B64, 'base64').length);
    expect(event?.usageUnreported).toBe(true);
    expect(JSON.stringify(gw.trace())).not.toContain(PNG_B64.slice(0, 16));
    // Расхода нет — и учёт звена его не выдумывает.
    const spend = await gw.control({ op: 'spend-of', tag: 'user:corp' });
    expect(spend.ok && spend.op === 'spend-of' ? spend.spend : 'x').toBeNull();
  });

  it('расход, присланный ручкой, считается', async () => {
    gw = await userGatewayStand(MANIFEST, {
      reply: contour(200, {
        data: [{ b64_json: PNG_B64 }],
        usage: { input_tokens: 12, output_tokens: 300, total_tokens: 312 },
      }),
    });
    await draw({ model: 'flux', prompt: 'кот' });
    const event = gw.trace().at(-1);
    expect(event?.tokens).toBe(312);
    expect(event?.usageUnreported).toBeUndefined();
    const spend = await gw.control({ op: 'spend-of', tag: 'user:corp' });
    const row = spend.ok && spend.op === 'spend-of' ? spend.spend : null;
    expect(row).toMatchObject({ input: 12, output: 300 });
  });

  it('503 контура НЕ повторяется: платная картинка — один запрос наверх', async () => {
    gw = await userGatewayStand(MANIFEST, {
      reply: contour(503, { error: { message: 'upstream model is unavailable' } }),
    });
    const answer = await draw({ prompt: 'кот' });
    expect(answer.status).toBeGreaterThanOrEqual(500);
    expect(calls).toHaveLength(1);
  });

  it('451 переведён: клиенту своя форма без текста проверки, в следе — отказ проверок', async () => {
    gw = await userGatewayStand(MANIFEST, {
      reply: contour(451, {
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
    });
    const answer = await draw({ prompt: 'паспорт' });
    expect(answer.status).toBe(400);
    expect(answer.text).toContain('content_policy_violation');
    expect(answer.text).not.toContain('Иванов');
    const event = gw.trace().at(-1);
    expect(event).toMatchObject({ status: 400, code: 'content_policy_violation' });
    expect((event?.violations as unknown[] | undefined)?.length).toBeGreaterThan(0);
    expect(JSON.stringify(event)).not.toContain('Иванов');
  });

  it('защита данных маскирует ПРОМПТ до отправки', async () => {
    gw = await userGatewayStand(MANIFEST, {
      reply: contour(200, { data: [{ b64_json: PNG_B64 }] }),
      prepare: (appData) => writeFileSync(rulesPath(appData), JSON.stringify({ rules: [RULE] })),
    });
    gw.writeContour(MANIFEST, { dlp: { enabled: true } });
    await gw.apply();
    const answer = await draw({ prompt: 'портрет Иванов' });
    expect(answer.status).toBe(200);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.raw).not.toContain('Иванов');
    expect(calls[0]?.raw).toContain('портрет');
  });

  it('правило «отклонить» не пускает промпт наружу', async () => {
    gw = await userGatewayStand(MANIFEST, {
      reply: contour(200, { data: [{ b64_json: PNG_B64 }] }),
      prepare: (appData) =>
        writeFileSync(
          rulesPath(appData),
          JSON.stringify({ rules: [{ ...RULE, action: 'block' }] }),
        ),
    });
    gw.writeContour(MANIFEST, { dlp: { enabled: true } });
    await gw.apply();
    const refused = await draw({ prompt: 'портрет Иванов' });
    expect(refused.status).toBe(400);
    expect(refused.text).toContain('Фамилии сотрудников');
    expect(calls).toHaveLength(0);
  });

  it('контур без объявленной ручки — 404 с причиной и без похода наружу', async () => {
    gw = await userGatewayStand({}, { reply: contour(200, {}) });
    const answer = await draw({ prompt: 'кот' });
    expect(answer.status).toBe(404);
    expect(answer.text).toContain('ручка картинок');
    expect(answer.text).toContain('Company · dev');
    expect(calls).toHaveLength(0);
  });
});
