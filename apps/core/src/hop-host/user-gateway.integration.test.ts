import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { HopControlReply, HopRegisterSpec } from '@agentdeck/contracts/core/hops';
import { afterEach, describe, expect, it } from 'vitest';
import { anthropicBody, hopStand, type HopStand } from './__fixtures__/hop-stand.ts';

/**
 * Шлюз человека на хосте звеньев (этап 10): постоянный адрес `/<контур>/v1/...` для CLI
 * человека. Переход без перерыва: порт занят прежним шлюзом — звено ждёт и берёт порт в тот миг,
 * когда его отпустили; запрос CLI проходит и до, и после. Конвейер — общий с меткой сеанса.
 */

const j = (...parts: string[]): string => parts.join('');
const EMAIL = j('olga.sidorova', '@', 'corp-example', '.ru');

let stand: HopStand | undefined;
let foreign: Server | undefined;
afterEach(async () => {
  await new Promise<void>((done) => (foreign?.listening ? foreign.close(() => done()) : done()));
  foreign = undefined;
  await stand?.close().catch(() => undefined);
  stand = undefined;
});

async function control(s: HopStand, message: unknown): Promise<HopControlReply> {
  const response = await fetch(`${s.handle.url}/hops`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${s.handle.token}` },
    body: JSON.stringify(message),
  });
  return (await response.json()) as HopControlReply;
}

function spec(s: HopStand, over: Partial<HopRegisterSpec> = {}): HopRegisterSpec {
  return {
    tag: 'user',
    sessionId: 'user',
    routeId: 'route-stub',
    upstream: s.stub.baseUrl,
    from: 'anthropic-messages',
    to: 'anthropic-messages',
    keyRef: null,
    dlp: { required: false, rulesHash: null },
    features: [],
    ...over,
  };
}

/** Чужой слушатель на свободном порту — прежний шлюз в панели. */
async function holdPort(): Promise<{ server: Server; port: number }> {
  const server = createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ from: 'old-gateway' }));
  });
  await new Promise<void>((done) => server.listen({ host: '127.0.0.1', port: 0 }, () => done()));
  return { server, port: (server.address() as AddressInfo).port };
}

async function freePort(): Promise<number> {
  const { server, port } = await holdPort();
  await new Promise<void>((done) => server.close(() => done()));
  return port;
}

async function call(port: number, path: string, body: unknown, headers = {}) {
  const response = await fetch(`http://127.0.0.1:${port}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': 'cli-own', ...headers },
    body: JSON.stringify(body),
  });
  return { status: response.status, text: await response.text() };
}

async function until(check: () => Promise<boolean>, ms: number): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (await check()) return true;
    await new Promise((done) => setTimeout(done, 50));
  }
  return false;
}

describe('шлюз человека: постоянный адрес контура на хосте звеньев', () => {
  it('порт занят прежним шлюзом — ждёт; отпустили — берёт за секунды, запрос CLI проходит до и после', async () => {
    stand = await hopStand({ script: ['after cutover'] });
    const held = await holdPort();
    foreign = held.server;
    const s = stand;
    const reply = await control(s, {
      op: 'user-gateway',
      port: held.port,
      routes: [{ platformId: 'corp', title: 'Corp', enabled: true, spec: spec(s) }],
    });
    expect(reply).toMatchObject({ op: 'user-gateway', ok: true, state: { state: 'waiting' } });
    // До: отвечает прежний шлюз, CLI не видит перерыва.
    const before = await call(held.port, '/corp/v1/messages', anthropicBody('hi'));
    expect(before.status).toBe(200);
    expect(before.text).toContain('old-gateway');
    const released = Date.now();
    await new Promise<void>((done) => held.server.close(() => done()));
    const took = await until(async () => {
      const status = await control(s, { op: 'status' });
      return (
        status.ok && status.op === 'status' && status.status.userGateway?.state === 'listening'
      );
    }, 5_000);
    expect(took).toBe(true);
    expect(Date.now() - released).toBeLessThan(5_000);
    const after = await call(held.port, '/corp/v1/messages', anthropicBody('hi'));
    expect(after.status).toBe(200);
    expect(after.text).toContain('after cutover');
    expect(s.seen).toHaveLength(1);
  });

  it('проба живости, неизвестный контур, выключенный контур, раздел и непереводимая ручка — до контура не доходят', async () => {
    stand = await hopStand({ script: ['never'] });
    const port = await freePort();
    const reply = await control(stand, {
      op: 'user-gateway',
      port,
      routes: [
        { platformId: 'corp', title: 'Corp', enabled: true, spec: spec(stand) },
        { platformId: 'off', title: 'Off', enabled: false, spec: spec(stand) },
      ],
    });
    expect(reply.ok).toBe(true);
    await until(async () => {
      const status = await control(stand!, { op: 'status' });
      return (
        status.ok && status.op === 'status' && status.status.userGateway?.state === 'listening'
      );
    }, 3_000);
    const hello = await fetch(`http://127.0.0.1:${port}/api/hello`);
    expect(hello.status).toBe(200);
    const unknown = await call(port, '/nobody/v1/messages', anthropicBody('hi'));
    expect(unknown.status).toBe(404);
    expect(unknown.text).toContain('nobody');
    expect((await call(port, '/off/v1/messages', anthropicBody('hi'))).status).toBe(403);
    expect((await call(port, '/corp/_s/hr/v1/messages', anthropicBody('hi'))).status).toBe(403);
    const responses = await call(port, '/corp/v1/responses', { model: 'm', input: 'hi' });
    expect(responses.status).toBe(400);
    expect(responses.text).toContain('openai-responses');
    expect(stand.seen).toHaveLength(0);
  });

  it('контур OpenAI chat с маской: Responses переводится, почта наверх уходит замаскированной; закрытие отпускает порт', async () => {
    stand = await hopStand({ script: ['masked'] });
    const port = await freePort();
    await control(stand, {
      op: 'user-gateway',
      port,
      routes: [
        {
          platformId: 'oa',
          title: 'OA',
          enabled: true,
          spec: spec(stand, { to: 'openai-chat', dlp: { required: true, rulesHash: null } }),
        },
      ],
    });
    await until(async () => {
      const status = await control(stand!, { op: 'status' });
      return (
        status.ok && status.op === 'status' && status.status.userGateway?.state === 'listening'
      );
    }, 3_000);
    const answer = await call(
      port,
      '/oa/_run/run-7/v1/responses',
      {
        model: 'stub-model',
        input: [{ role: 'user', content: [{ type: 'input_text', text: `write ${EMAIL}` }] }],
        stream: true,
        store: false,
      },
      { authorization: 'Bearer cli-own' },
    );
    expect(answer.status).toBe(200);
    expect(answer.text).toContain('response.completed');
    expect(stand.seen).toHaveLength(1);
    expect(stand.seen[0]?.path).toBe('/v1/chat/completions');
    expect(stand.seen[0]?.raw).not.toContain(EMAIL);
    // Метка запуска из адреса (`/_run/<метка>`) — расход ложится на неё, а не на контур целиком.
    const spend = await control(stand, { op: 'spend-of', tag: 'user:oa:run-7' });
    expect(spend.ok && spend.op === 'spend-of' ? spend.spend : null).not.toBeNull();
    const whole = await control(stand, { op: 'spend-of', tag: 'user:oa' });
    expect(whole.ok && whole.op === 'spend-of' ? whole.spend : 'x').toBeNull();
    const closed = await control(stand, { op: 'user-gateway', port: null, routes: [] });
    expect(closed).toMatchObject({ ok: true, state: null });
    await expect(fetch(`http://127.0.0.1:${port}/api/hello`)).rejects.toThrow();
  });

  it('порт из 5170–5180, кроме порта продукта, — отказ настройки', async () => {
    stand = await hopStand({ script: ['never'] });
    const reply = await control(stand, { op: 'user-gateway', port: 5175, routes: [] });
    expect(reply).toMatchObject({ ok: false, code: 'bad_port' });
    const status = await control(stand, { op: 'status' });
    expect(status.ok && status.op === 'status' ? status.status.userGateway : 'x').toBeNull();
  });
});
