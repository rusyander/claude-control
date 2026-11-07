import { afterEach, describe, expect, it } from 'vitest';
import { startStand, TOKENS, type Stand } from './__fixtures__/api-harness.ts';

/**
 * Запись учёта контуров снаружи снята (этап 11): учёт пишет только трафик звена, прежний шлюз,
 * славший `POST /v1/contours/record`, удалён. Маршрута нет вовсе — 404 даже с токеном ядра, а не
 * «не подключено» (501): иначе писатель мимо звена ожил бы, стоит порту появиться. Чтения
 * контуров при этом на месте — без порта они по-прежнему 501.
 */

let stand: Stand | undefined;
afterEach(async () => {
  await stand?.close();
  stand = undefined;
});

const post = (path: string, token: string, body: unknown) =>
  fetch(`${stand!.url}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });

describe('contours API: no outside writer of the contour ledger (stage 11)', () => {
  it('POST /v1/contours/record is not a route: 404 for the core and the panel token', async () => {
    stand = await startStand();
    const record = { platformId: 'p1', model: 'm', inputTokens: 11, outputTokens: 2 };
    for (const token of [TOKENS.core, TOKENS.panel]) {
      const res = await post('/v1/contours/record', token, record);
      expect({ token, status: res.status }).toEqual({ token, status: 404 });
    }
    // Чтение того же раздела зарегистрировано: без порта — «не подключено», а не «нет маршрута».
    const read = await stand.get('/v1/contours', TOKENS.core);
    expect(read.status).toBe(501);
  });
});
