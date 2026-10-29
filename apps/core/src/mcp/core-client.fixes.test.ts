import { describe, expect, it } from 'vitest';
import type { HttpJsonCall, HttpJsonOutcome } from '../platform/http-json.ts';
import { createCoreClient } from './core-client.ts';

/**
 * core-s2 F-91: `503` ядра значит «не обработано, вернись» — повторяется и для вызова с
 * последствиями (он не исполнялся), но не дольше своего короткого окна: постоянный 503 не
 * держит вопрос CLI минуту. Поиск ядра может быть асинхронным (проверка личности, F-19).
 */

function clock() {
  let t = 0;
  return { now: () => t, sleep: async (ms: number) => void (t += ms) };
}

function scripted(outcomes: HttpJsonOutcome[], fallback: HttpJsonOutcome) {
  const calls: HttpJsonCall[] = [];
  return {
    calls,
    http: async (call: HttpJsonCall) => {
      calls.push(call);
      return outcomes.shift() ?? fallback;
    },
  };
}

const UNAVAILABLE: HttpJsonOutcome = { kind: 'reply', status: 503, body: { code: 'busy' } };
const OK: HttpJsonOutcome = { kind: 'reply', status: 200, body: { ok: true } };

describe('core-s2 mcp core client — 503 window and async discovery', () => {
  it('F-91 a 503 on a call with effects is retried (the core did not run it), then the reply returns', async () => {
    const c = clock();
    const s = scripted([UNAVAILABLE, UNAVAILABLE], OK);
    const client = createCoreClient({
      url: 'http://127.0.0.1:1',
      token: 't',
      retryForMs: 60_000,
      stepMs: 500,
      timeoutMs: 10,
      http: s.http,
      ...c,
    });
    expect(await client.post('/v1/session/tools/step_done', {})).toMatchObject({ status: 200 });
    expect(s.calls).toHaveLength(3);
  });

  it('F-91 a persistent 503 gives up after the short unavailable window, not the whole restart window', async () => {
    const c = clock();
    const s = scripted([], UNAVAILABLE);
    const client = createCoreClient({
      url: 'http://127.0.0.1:1',
      token: 't',
      retryForMs: 60_000,
      unavailableForMs: 10_000,
      stepMs: 500,
      timeoutMs: 10,
      http: s.http,
      ...c,
    });
    expect(await client.post('/v1/session/permit', {}, { idempotent: true })).toMatchObject({
      status: 503,
    });
    expect(c.now()).toBeLessThanOrEqual(10_500);
    expect(c.now()).toBeGreaterThanOrEqual(10_000);
  });

  it('F-19 async rediscovery: a refused core is replaced by the address the check confirmed', async () => {
    const c = clock();
    const s = scripted([{ kind: 'unreachable', reason: 'ECONNREFUSED', refused: true }], OK);
    const client = createCoreClient({
      url: 'http://127.0.0.1:1',
      token: 't',
      retryForMs: 60_000,
      stepMs: 500,
      timeoutMs: 10,
      http: s.http,
      rediscover: async () => 'http://127.0.0.1:2',
      ...c,
    });
    expect(await client.get('/v1/session/tools')).toMatchObject({ status: 200 });
    expect(s.calls.map((x) => x.url)).toEqual([
      'http://127.0.0.1:1/v1/session/tools',
      'http://127.0.0.1:2/v1/session/tools',
    ]);
  });
});
