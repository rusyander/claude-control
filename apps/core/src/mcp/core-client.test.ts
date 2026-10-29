import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { tempDir } from '../journal/__fixtures__/journal-harness.ts';
import type { HttpJsonCall, HttpJsonOutcome } from '../platform/http-json.ts';
import { PERMIT_TOOL } from '@agentdeck/contracts/core/model-tools';
import { agentdeckHandlers, bridgeEnv, CORE_PROCS_VAR, permitHandlers } from './bridges.ts';
import { createCoreClient } from './core-client.ts';
import { coreSince, newestCore } from './main.ts';
import type { CoreCheck } from './core-discovery.ts';

/**
 * Мост повторяет только недошедший запрос (ядро не принимает соединение — перезапуск): дошедший
 * и оборванный не повторяется, иначе второй `step_done` стал бы вторым заявлением.
 */

function scripted(outcomes: HttpJsonOutcome[]) {
  const calls: HttpJsonCall[] = [];
  return {
    calls,
    http: async (call: HttpJsonCall) => {
      calls.push(call);
      return outcomes.shift() ?? { kind: 'unreachable', reason: 'empty', refused: true };
    },
  };
}

describe('mcp core client', () => {
  const base = { url: 'http://127.0.0.1:1/', token: 't', stepMs: 1, timeoutMs: 10 };

  it('retries a refused connection until the core answers, then returns the reply', async () => {
    const s = scripted([
      { kind: 'unreachable', reason: 'ECONNREFUSED', refused: true },
      { kind: 'unreachable', reason: 'ECONNREFUSED', refused: true },
      { kind: 'reply', status: 200, body: { ok: true } },
    ]);
    const client = createCoreClient({
      ...base,
      retryForMs: 10_000,
      http: s.http,
      sleep: async () => {},
    });
    expect(await client.post('/v1/session/tools/core_state', { input: {} })).toMatchObject({
      kind: 'reply',
      status: 200,
    });
    expect(s.calls).toHaveLength(3);
    expect(s.calls[0]).toMatchObject({
      url: 'http://127.0.0.1:1/v1/session/tools/core_state',
      method: 'POST',
      bearer: 't',
    });
  });

  it('never repeats a request that reached the core; gives up on refusal after the window', async () => {
    const reached = scripted([{ kind: 'unreachable', reason: 'socket hang up', refused: false }]);
    const once = createCoreClient({
      ...base,
      retryForMs: 10_000,
      http: reached.http,
      sleep: async () => {},
    });
    expect(await once.post('/x', {})).toMatchObject({ kind: 'unreachable', refused: false });
    expect(reached.calls).toHaveLength(1);

    let clock = 0;
    const down = scripted([]);
    const late = createCoreClient({
      ...base,
      retryForMs: 100,
      http: down.http,
      sleep: async (ms) => {
        clock += ms * 30;
      },
      now: () => clock,
    });
    expect(await late.get('/v1/session/tools')).toMatchObject({ kind: 'unreachable' });
    expect(down.calls.length).toBeGreaterThan(1);
    expect(down.calls.length).toBeLessThan(10);
  });

  it('a restarted core on a new port is found through procs.json; later calls stay with it', async () => {
    const s = scripted([
      { kind: 'unreachable', reason: 'ECONNREFUSED', refused: true },
      { kind: 'reply', status: 200, body: { ok: true } },
      { kind: 'reply', status: 200, body: { ok: true } },
    ]);
    const asked: string[] = [];
    const client = createCoreClient({
      ...base,
      retryForMs: 10_000,
      http: s.http,
      sleep: async () => {},
      rediscover: (current) => {
        asked.push(current);
        return 'http://127.0.0.1:2/';
      },
    });
    await client.post('/v1/session/permit', { raw: {} });
    await client.get('/v1/session/tools');
    expect(s.calls.map((c) => c.url)).toEqual([
      'http://127.0.0.1:1/v1/session/permit',
      'http://127.0.0.1:2/v1/session/permit',
      'http://127.0.0.1:2/v1/session/tools',
    ]);
    expect(asked).toEqual(['http://127.0.0.1:1']);
  });

  it('a request that reached the dying core is not carried to the new one', async () => {
    const s = scripted([{ kind: 'unreachable', reason: 'socket hang up', refused: false }]);
    let asked = 0;
    const client = createCoreClient({
      ...base,
      retryForMs: 10_000,
      http: s.http,
      sleep: async () => {},
      rediscover: () => {
        asked += 1;
        return 'http://127.0.0.1:2/';
      },
    });
    expect(await client.post('/v1/session/tools/step_done', {})).toMatchObject({ refused: false });
    expect(s.calls).toHaveLength(1);
    expect(asked).toBe(0);
  });

  it('a harmless question cut by the core dying goes to the core started after the cut, never back to the old one', async () => {
    const s = scripted([
      { kind: 'unreachable', reason: 'socket hang up', refused: false },
      { kind: 'reply', status: 503, body: { code: 'permit-unavailable' } },
      { kind: 'reply', status: 200, body: { reply: { behavior: 'allow' } } },
    ]);
    let clock = 1_000;
    let started: { url: string; at: number } | null = null;
    const since: number[] = [];
    let polls = 0;
    const client = createCoreClient({
      ...base,
      retryForMs: 10_000,
      http: s.http,
      now: () => clock,
      sleep: async () => {
        clock += 100;
        polls += 1;
        // Новое ядро поднимается на третьем такте ожидания, на другом порту.
        if (polls === 3) started = { url: 'http://127.0.0.1:2/', at: clock };
      },
      newCore: (t) => {
        since.push(t);
        return started && started.at > t ? started.url : null;
      },
    });
    expect(
      await client.post('/v1/session/permit', { raw: {} }, { idempotent: true }),
    ).toMatchObject({ kind: 'reply', status: 200 });
    // Обрыв → ожидание нового ядра без запросов → 503 (сессия ещё не прикреплена) → ответ.
    expect(s.calls.map((c) => c.url)).toEqual([
      'http://127.0.0.1:1/v1/session/permit',
      'http://127.0.0.1:2/v1/session/permit',
      'http://127.0.0.1:2/v1/session/permit',
    ]);
    expect(since.every((t) => t === 1_000)).toBe(true);
    expect(since.length).toBeGreaterThanOrEqual(3);
  });

  it('a cut harmless question with no newer core gives up after the window; the old core is not asked twice', async () => {
    const s = scripted([{ kind: 'unreachable', reason: 'timeout', refused: false }]);
    let clock = 0;
    const client = createCoreClient({
      ...base,
      retryForMs: 1_000,
      http: s.http,
      now: () => clock,
      sleep: async () => {
        clock += 300;
      },
      newCore: () => null,
    });
    expect(
      await client.post('/v1/session/permit', { raw: {} }, { idempotent: true }),
    ).toMatchObject({ kind: 'unreachable', reason: 'timeout' });
    expect(s.calls).toHaveLength(1);
  });

  // core-s2 F-91: 503 ядра — «не обработано», повтор безопасен и для вызова с последствиями.
  it('a 503 is retried for a call with effects too, at the same core', async () => {
    const s = scripted([
      { kind: 'reply', status: 503, body: {} },
      { kind: 'reply', status: 200, body: { ok: true } },
    ]);
    const client = createCoreClient({
      ...base,
      retryForMs: 10_000,
      http: s.http,
      sleep: async () => {},
      newCore: () => 'http://127.0.0.1:2/',
    });
    expect(await client.post('/v1/session/tools/step_done', {})).toMatchObject({ status: 200 });
    expect(s.calls.map((c) => c.url)).toEqual([
      'http://127.0.0.1:1/v1/session/tools/step_done',
      'http://127.0.0.1:1/v1/session/tools/step_done',
    ]);
  });
});

describe('newest core in procs.json', () => {
  // procs.json отдаёт только loopback-строки с портом адреса = порт строки (core-s2 F-19).
  const A = 'http://127.0.0.1:1';
  const NEW = 'http://127.0.0.1:2/';
  const entry = (url: string, startedAt: number) => ({
    build: 'b',
    pid: 1,
    pidStart: 's',
    bootId: `boot-${startedAt}`,
    port: Number(new URL(url).port),
    url,
    startedAt,
    home: '/h',
    portDecision: { rejected: [] },
  });

  // Выбор строки; проверка личности ядра (core-s2 F-19) — в core-discovery.test.ts, здесь пропуск.
  const pass: CoreCheck = async (row) => row.url;

  it('names the latest core unless it is the one that refused; no file or garbage is no answer', async () => {
    const dir = tempDir('mcp-procs-');
    const path = join(dir, 'procs.json');
    expect(await newestCore(path, A, pass)).toBeNull();
    writeFileSync(path, 'not json');
    expect(await newestCore(path, A, pass)).toBeNull();
    writeFileSync(
      path,
      JSON.stringify({
        v: 1,
        cores: [entry(NEW, 20), entry(A, 10)],
        servers: [],
      }),
    );
    expect(await newestCore(path, A, pass)).toBe(NEW);
    expect(await newestCore(path, 'http://127.0.0.1:2', pass)).toBeNull();
    writeFileSync(path, JSON.stringify({ v: 1, cores: [], servers: [] }));
    expect(await newestCore(path, A, pass)).toBeNull();
  });

  it('a core started after the cut is named even on the same address; an older or equal one is not', async () => {
    const dir = tempDir('mcp-procs-since-');
    const path = join(dir, 'procs.json');
    expect(await coreSince(path, 0, pass)).toBeNull();
    writeFileSync(path, JSON.stringify({ v: 1, cores: [entry(A, 10), entry(A, 30)], servers: [] }));
    expect(await coreSince(path, 20, pass)).toBe(A);
    expect(await coreSince(path, 30, pass)).toBeNull();
    expect(await coreSince(path, 40, pass)).toBeNull();
  });

  it('the permit bridge asks as a harmless call; the model-tool bridge does not', async () => {
    const seen: [string, unknown][] = [];
    const client = {
      get: async () => ({ kind: 'reply', status: 200, body: { tools: [] } }) as const,
      post: async (path: string, _body: unknown, call?: unknown) => {
        seen.push([path, call]);
        return { kind: 'reply', status: 200, body: { reply: {}, ok: true } } as const;
      },
    };
    await permitHandlers(client).call(PERMIT_TOOL, { tool_name: 'Bash' });
    await agentdeckHandlers(client).call('step_done', {});
    expect(seen).toEqual([
      ['/v1/session/permit', { idempotent: true }],
      ['/v1/session/tools/step_done', undefined],
    ]);
  });

  it('the bridge env carries the procs path when the launch gave it', () => {
    const env = { AGENTDECK_CORE_URL: 'http://a', AGENTDECK_SESSION_TOKEN: 't' };
    expect(bridgeEnv(env)).toEqual({ url: 'http://a', token: 't' });
    expect(bridgeEnv({ ...env, [CORE_PROCS_VAR]: '/h/procs.json' })).toEqual({
      url: 'http://a',
      token: 't',
      procs: '/h/procs.json',
    });
  });
});
