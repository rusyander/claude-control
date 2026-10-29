import { PassThrough } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { PROTOCOL_VERSIONS, serveStdio, type McpHandlers } from './stdio-server.ts';

/**
 * Сервер MCP моста по stdio (core-s2 F-85, F-74, F-91): пульс прогресса, ping, неизвестный метод,
 * отмена вызова, выбор версии протокола, ответ ядра без списка, уход по закрытию stdin.
 * Вход — настоящий поток, ответы — строки, как их читает CLI.
 */

// Ответы JSON-RPC читаются вглубь (result.tools[0].name) — точная схема здесь только мешала бы.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Rpc = Record<string, any>;

function serve(handlers: McpHandlers, progressMs = 0, closeGraceMs?: number) {
  const input = new PassThrough();
  const out: Rpc[] = [];
  let closed = false;
  const served = serveStdio({
    name: 'agentdeck',
    version: '1.0.0',
    handlers,
    input,
    write: (line) => out.push(JSON.parse(line) as Rpc),
    progressMs,
    ...(closeGraceMs === undefined ? {} : { closeGraceMs }),
  }).then(() => {
    closed = true;
  });
  return {
    out,
    send: (msg: Rpc) => input.write(`${JSON.stringify({ jsonrpc: '2.0', ...msg })}\n`),
    raw: (line: string) => input.write(`${line}\n`),
    end: () => input.end(),
    served,
    isClosed: () => closed,
  };
}

const until = async (cond: () => boolean, ms = 3_000): Promise<void> => {
  const deadline = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error('condition not met in time');
    await new Promise((d) => setTimeout(d, 5));
  }
};
const pause = (ms: number) => new Promise((d) => setTimeout(d, ms));
const never = <T>(): Promise<T> => new Promise<T>(() => undefined);

const TOOLS: McpHandlers = {
  list: async () => [{ name: 'core_state', description: 'd', inputSchema: { type: 'object' } }],
  call: async (name) => ({ text: `called ${name}`, isError: false }),
};

describe('core-s2 MCP stdio server', () => {
  it('F-85 initialize answers a known protocol version as asked and an unknown or missing one with the latest known', async () => {
    const s = serve(TOOLS);
    s.send({ id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05' } });
    s.send({ id: 2, method: 'initialize', params: { protocolVersion: 'bogus-9' } });
    s.send({ id: 3, method: 'initialize' });
    await until(() => s.out.length === 3);
    const latest = PROTOCOL_VERSIONS[PROTOCOL_VERSIONS.length - 1];
    expect(s.out.map((m) => m.result.protocolVersion)).toEqual(['2024-11-05', latest, latest]);
    expect(s.out[0]?.result).toMatchObject({
      capabilities: { tools: {} },
      serverInfo: { name: 'agentdeck', version: '1.0.0' },
    });
    s.end();
    await s.served;
  });

  it('F-85 ping → empty result; unknown method → -32601; notifications and garbage get no answer', async () => {
    const s = serve(TOOLS);
    s.raw('not json');
    s.raw('[1,2]');
    s.send({ method: 'notifications/initialized' });
    s.send({ id: 'p', method: 'ping' });
    s.send({ id: 9, method: 'resources/list' });
    await until(() => s.out.length === 2);
    expect(s.out).toEqual([
      { jsonrpc: '2.0', id: 'p', result: {} },
      { jsonrpc: '2.0', id: 9, error: { code: -32601, message: 'Method not found' } },
    ]);
    s.end();
    await s.served;
  });

  it('F-85 a slow call sends progress by its token until the answer, then stops; no token → no progress', async () => {
    let release: (v: { text: string; isError: boolean }) => void = () => undefined;
    const s = serve({ list: TOOLS.list, call: () => new Promise((d) => (release = d)) }, 20);
    s.send({
      id: 4,
      method: 'tools/call',
      params: { name: 'core_state', _meta: { progressToken: 'tok' } },
    });
    await until(() => s.out.length >= 3);
    expect(s.out[0]).toMatchObject({
      method: 'notifications/progress',
      params: { progressToken: 'tok', progress: 1 },
    });
    release({ text: 'done', isError: false });
    await until(() => s.out.some((m) => m.id === 4));
    const count = s.out.length;
    await pause(80);
    expect(s.out.length).toBe(count);
    expect(s.out.at(-1)).toEqual({
      jsonrpc: '2.0',
      id: 4,
      result: { content: [{ type: 'text', text: 'done' }], isError: false },
    });
    s.end();
    await s.served;
  });

  it('F-85 a cancelled call stops its progress and gets no answer; a failing call is still answered as an error', async () => {
    let release: (v: { text: string; isError: boolean }) => void = () => undefined;
    let calls = 0;
    const s = serve(
      {
        list: TOOLS.list,
        call: () => {
          calls += 1;
          return calls === 1
            ? new Promise((d) => (release = d))
            : Promise.reject(new Error('boom'));
        },
      },
      20,
    );
    s.send({ id: 5, method: 'tools/call', params: { name: 'x', _meta: { progressToken: 7 } } });
    await until(() => s.out.length >= 1);
    s.send({ method: 'notifications/cancelled', params: { requestId: 5, reason: 'user' } });
    await pause(30);
    const after = s.out.length;
    release({ text: 'late', isError: false });
    await pause(80);
    expect(s.out.length).toBe(after);
    expect(s.out.some((m) => m.id === 5)).toBe(false);
    s.send({ id: 6, method: 'tools/call', params: { name: 'x' } });
    await until(() => s.out.some((m) => m.id === 6));
    expect(s.out.find((m) => m.id === 6)?.result).toEqual({
      content: [{ type: 'text', text: 'bridge failure: boom' }],
      isError: true,
    });
    s.end();
    await s.served;
  });

  it('F-74 tools/list: a core answer without a tool list, an error answer and a rejection are JSON-RPC errors, never a crash', async () => {
    const answers: unknown[] = [undefined, { error: 'core refused (500)' }, { tools: 'nope' }];
    const s = serve({
      list: () => {
        const next = answers.shift();
        return next === 'reject'
          ? Promise.reject(new Error('down'))
          : Promise.resolve(next as never);
      },
      call: TOOLS.call,
    });
    s.send({ id: 1, method: 'tools/list' });
    s.send({ id: 2, method: 'tools/list' });
    s.send({ id: 3, method: 'tools/list' });
    await until(() => s.out.length === 3);
    expect(s.out.map((m) => [m.id, m.error?.code])).toEqual([
      [1, -32603],
      [2, -32603],
      [3, -32603],
    ]);
    expect(s.out[1]?.error.message).toBe('core refused (500)');
    const ok = serve({ list: () => Promise.reject(new Error('down')), call: TOOLS.call });
    ok.send({ id: 8, method: 'tools/list' });
    await until(() => ok.out.length === 1);
    expect(ok.out[0]?.error).toEqual({ code: -32603, message: 'down' });
    const good = serve(TOOLS);
    good.send({ id: 9, method: 'tools/list' });
    await until(() => good.out.length === 1);
    expect(good.out[0]?.result.tools[0].name).toBe('core_state');
    for (const x of [s, ok, good]) x.end();
    await Promise.all([s.served, ok.served, good.served]);
  });

  it('F-91 stdin closed with a call still waiting for the core → the server ends after the grace, no answer sent', async () => {
    const s = serve({ list: TOOLS.list, call: () => never() }, 10, 100);
    s.send({ id: 1, method: 'tools/call', params: { name: 'x', _meta: { progressToken: 1 } } });
    await until(() => s.out.length >= 1);
    s.end();
    await until(() => s.isClosed(), 2_000);
    const count = s.out.length;
    await pause(50);
    expect(s.out.length).toBe(count);
    expect(s.out.some((m) => m.id === 1)).toBe(false);
  });
});
