import { createServer, type Server } from 'node:http';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { processStartOf } from '../../lib/listen-identity/listen-identity.ts';
import { createCoreProxyRoutes } from './core-proxy-routes.ts';

/**
 * F10 (core-s9): прокладка отдавала bearer ядра любому адресу из `procs.json`. Здесь — настоящая
 * прокладка с настоящими чтениями ОС (слушатель порта, старт процесса), «ядро» — заглушка в этом
 * процессе, которая только записывает, кто и с каким токеном к ней пришёл. Строка, которую не
 * подтвердила ОС, не должна довести до заглушки ни одного запроса — значит, и токена.
 */

const TOKEN = 'core-token-for-the-identity-test';

let home = '';
let stub: Server | undefined;
let stubPort = 0;
let panel: FastifyInstance | undefined;
let panelUrl = '';
let ownStart = '';
const seen: { path?: string; auth?: string; lastEventId?: string; peer?: string; body?: string }[] =
  [];
function signal() {
  let resolve = () => {};
  const promise = new Promise<void>((done) => (resolve = done));
  return { promise, resolve };
}
let streamClosed = signal();

function writeRow(row: Record<string, unknown>) {
  const entry = {
    build: 'test',
    pid: process.pid,
    pidStart: ownStart,
    bootId: 'boot',
    port: stubPort,
    url: `http://127.0.0.1:${stubPort}`,
    startedAt: Date.now(),
    home,
    portDecision: { rejected: [] },
    ...row,
  };
  writeFileSync(join(home, 'procs.json'), JSON.stringify({ v: 1, cores: [entry], servers: [] }));
}

beforeAll(async () => {
  home = mkdtempSync(join(tmpdir(), 'cc-core-identity-'));
  writeFileSync(join(home, 'token'), TOKEN);
  stub = createServer((req, res) => {
    const row: (typeof seen)[number] = { path: req.url, auth: req.headers.authorization };
    const lastEventId = req.headers['last-event-id'];
    if (typeof lastEventId === 'string') row.lastEventId = lastEventId;
    const peer = req.headers['x-agentdeck-peer-pid'];
    if (typeof peer === 'string') row.peer = peer;
    seen.push(row);
    if (req.url?.endsWith('/events')) {
      // Лента: первая строка сразу, ответ не кончается, пока клиент не уйдёт.
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write('id: 6\nevent: line\ndata: {"seq":6}\n\n');
      req.on('close', () => streamClosed.resolve());
      return;
    }
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      if (chunks.length > 0) row.body = Buffer.concat(chunks).toString('utf8');
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ ok: true }));
    });
  });
  await new Promise<void>((done) => stub!.listen(0, '127.0.0.1', done));
  stubPort = (stub.address() as AddressInfo).port;
  const start = await processStartOf(process.pid);
  if (!start) throw new Error('own process start is unreadable on this OS');
  ownStart = start;

  panel = Fastify({ logger: false });
  createCoreProxyRoutes({ home: () => home, readTcp: async () => undefined })(panel);
  await panel.listen({ host: '127.0.0.1', port: 0 });
  panelUrl = `http://127.0.0.1:${(panel.server.address() as AddressInfo).port}`;
}, 30_000);

afterAll(async () => {
  await panel?.close();
  await new Promise((done) => (stub ? stub.close(done) : done(undefined)));
  rmSync(home, { recursive: true, force: true });
});

beforeEach(() => {
  seen.length = 0;
});

describe('core proxy sends the core bearer only to a verified core (F10, F-19)', () => {
  it('a row whose pid does not own the listening port gets no request and no bearer', async () => {
    // Порт слушает этот процесс, а строка называет другой (живой) — подставленная строка.
    writeRow({ pid: process.ppid });
    const res = await fetch(`${panelUrl}/api/core/tasks`);
    expect(seen).toEqual([]);
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ code: 'core-unverified' });
  });

  it('a row whose pid owns the port but with another start (reused pid) gets no bearer', async () => {
    writeRow({ pidStart: '1' });
    const res = await fetch(`${panelUrl}/api/core/tasks`);
    expect(seen).toEqual([]);
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ code: 'core-unverified' });
  });

  it('a stale row of a killed core reads as a core that is not running', async () => {
    // Номер, которого не бывает: на Windows pid кратен 4, на Linux выше pid_max по умолчанию.
    writeRow({ pid: 2 ** 22 + 7 });
    const res = await fetch(`${panelUrl}/api/core/tasks`);
    expect(seen).toEqual([]);
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ code: 'core-absent' });
  });

  it('a row whose url points elsewhere than its own port is not a loopback core', async () => {
    writeRow({ port: stubPort === 65_535 ? 1 : stubPort + 1 });
    const res = await fetch(`${panelUrl}/api/core/tasks`);
    expect(seen).toEqual([]);
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ code: 'core-absent' });
  });

  it('a row with a non-loopback host is not a loopback core', async () => {
    writeRow({ url: `http://example.invalid:${stubPort}` });
    const res = await fetch(`${panelUrl}/api/core/tasks`);
    expect(seen).toEqual([]);
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ code: 'core-absent' });
  });

  it('the verified row gets the request with the bearer and the query string', async () => {
    writeRow({});
    const res = await fetch(`${panelUrl}/api/core/nonce?page=p-1`);
    expect(res.status).toBe(200);
    expect(seen).toEqual([{ path: '/v1/nonce?page=p-1', auth: `Bearer ${TOKEN}` }]);
  });
});

describe('core proxy routes come from the contract list (stage 9)', () => {
  it('a POST carries the body and the peer pid set by the proxy, a GET carries neither', async () => {
    writeRow({});
    const post = await fetch(`${panelUrl}/api/core/scenarios`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-agentdeck-peer-pid': '4242' },
      body: JSON.stringify({ cmdId: 'c' }),
    });
    const get = await fetch(`${panelUrl}/api/core/profiles/${encodeURIComponent('a/b c')}`, {
      headers: { 'x-agentdeck-peer-pid': '4242' },
    });
    expect([post.status, get.status]).toEqual([200, 200]);
    // readTcp заглушки не отвечает — pid пира 0, а не 4242 клиента.
    expect(seen).toEqual([
      { path: '/v1/scenarios', auth: `Bearer ${TOKEN}`, peer: '0', body: '{"cmdId":"c"}' },
      { path: '/v1/profiles/a%2Fb%20c', auth: `Bearer ${TOKEN}` },
    ]);
  });

  it('the device adoption (G9) is forwarded: the phone keys reach the core through the panel', async () => {
    writeRow({});
    const res = await fetch(`${panelUrl}/api/core/devices/adopt`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ cmdId: 'd' }),
    });
    expect(res.status).toBe(200);
    expect(seen).toEqual([
      { path: '/v1/devices/adopt', auth: `Bearer ${TOKEN}`, peer: '0', body: '{"cmdId":"d"}' },
    ]);
  });

  it('a path outside the contract list never reaches the core', async () => {
    writeRow({});
    const res = await fetch(`${panelUrl}/api/core/session/hook`, { method: 'POST', body: '{}' });
    expect(res.status).toBe(404);
    expect(seen).toEqual([]);
  });

  it('the event stream passes through unbuffered with Last-Event-ID, and closes upstream when the client leaves', async () => {
    writeRow({});
    streamClosed = signal();
    const abort = new AbortController();
    const res = await fetch(`${panelUrl}/api/core/tasks/t-1/events`, {
      headers: { 'last-event-id': '5' },
      signal: abort.signal,
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('text/event-stream');
    // Ядро ответа не закончило: первая строка дошла, значит прокладка тело не копит.
    const reader = res.body!.getReader();
    const first = await reader.read();
    expect(new TextDecoder().decode(first.value)).toBe('id: 6\nevent: line\ndata: {"seq":6}\n\n');
    expect(seen).toEqual([
      { path: '/v1/tasks/t-1/events', auth: `Bearer ${TOKEN}`, lastEventId: '5' },
    ]);
    abort.abort();
    await streamClosed.promise;
  });
});
