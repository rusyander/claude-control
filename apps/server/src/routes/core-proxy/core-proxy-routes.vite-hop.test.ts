import { spawn, type ChildProcess } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { processStartOf } from '../../lib/listen-identity/listen-identity.ts';
import { readTcpTable } from '../../lib/peer-process/peer-process.ts';
import { FORWARDED_PEER_HEADER } from '../../domains/core-proxy/core-proxy.ts';
import { createCoreProxyRoutes } from './core-proxy-routes.ts';

/**
 * Звено dev-сервера: браузер → Vite :8888 → панель → ядро. Ядро должно судить pid того, кто
 * прислал команду, а не pid Vite. Vite — настоящий, с настоящим `apps/web/vite.config.ts`,
 * отдельным процессом (у звена свой pid, иначе проверка не различила бы звено и клиента);
 * панель — настоящая прокладка с настоящей таблицей TCP; ядро — заглушка, которая только
 * записывает заголовки (суд ядра над pid проверяет P23 в `apps/core`).
 *
 * Дом процесса Vite — одноразовый: конфиг читает `~/.agentdeck/api-token`, тест его не трогает.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const WEB = resolve(HERE, '../../../../web');
const VITE_HOP = join(HERE, '__fixtures__', 'vite-hop.mjs');

let home = '';
let core: Server | undefined;
let panel: FastifyInstance | undefined;
let vite: ChildProcess | undefined;
let vitePort = 0;
let vitePid = 0;
const seen: Record<string, string | undefined>[] = [];

beforeAll(async () => {
  home = mkdtempSync(join(tmpdir(), 'cc-core-hop-'));
  core = createServer((req, res) => {
    seen.push({
      path: req.url,
      peer: req.headers[FORWARDED_PEER_HEADER] as string | undefined,
      auth: req.headers.authorization,
    });
    req.resume();
    req.on('end', () => {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ ok: true }));
    });
  });
  await new Promise<void>((done) => core!.listen(0, '127.0.0.1', done));
  const corePort = (core.address() as AddressInfo).port;
  writeFileSync(join(home, 'token'), 'core-token-for-the-hop-test');
  // Строка — настоящая: порт слушает этот процесс, старт — от ОС (прокладка сверяет её до bearer, F10).
  const pidStart = await processStartOf(process.pid);
  if (!pidStart) throw new Error('own process start is unreadable on this OS');
  writeFileSync(
    join(home, 'procs.json'),
    JSON.stringify({
      v: 1,
      cores: [
        {
          build: 'test',
          pid: process.pid,
          pidStart,
          bootId: 'boot',
          port: corePort,
          url: `http://127.0.0.1:${corePort}`,
          startedAt: Date.now(),
          home,
          portDecision: { rejected: [] },
        },
      ],
      servers: [],
    }),
  );

  panel = Fastify({ logger: false });
  createCoreProxyRoutes({ home: () => home, readTcp: (wanted) => readTcpTable(wanted) })(panel);
  await panel.listen({ host: '127.0.0.1', port: 0 });
  const panelPort = (panel.server.address() as AddressInfo).port;

  const child = spawn(process.execPath, [VITE_HOP, WEB], {
    cwd: WEB,
    env: {
      ...process.env,
      API_PORT: String(panelPort),
      VITE_NO_RELOAD: '1',
      HOME: home,
      USERPROFILE: home,
    },
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  vite = child;
  const first = await new Promise<string>((done, fail) => {
    const timer = setTimeout(() => fail(new Error('vite did not start')), 60_000);
    child.once('exit', (code) => fail(new Error(`vite exited ${code}`)));
    createInterface({ input: child.stdout as NodeJS.ReadableStream }).once('line', (line) => {
      clearTimeout(timer);
      done(line);
    });
  });
  ({ port: vitePort, pid: vitePid } = JSON.parse(first) as { port: number; pid: number });
}, 90_000);

afterAll(async () => {
  if (vite && vite.exitCode === null) {
    const exited = new Promise((done) => vite!.once('exit', done));
    vite.kill();
    await exited;
  }
  await panel?.close();
  await new Promise((done) => (core ? core.close(done) : done(undefined)));
  rmSync(home, { recursive: true, force: true });
});

describe('core proxy behind the Vite dev hop', () => {
  it('the core gets the pid of the client behind Vite, never the Vite pid or a client-chosen header', async () => {
    expect(vitePid).not.toBe(process.pid);
    seen.length = 0;
    const res = await fetch(`http://127.0.0.1:${vitePort}/api/core/commands`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        // Клиент выдаёт себя за другой процесс обоими заголовками — оба не доходят.
        'x-agentdeck-client-port': '1',
        [FORWARDED_PEER_HEADER]: '4242',
      },
      body: JSON.stringify({ kind: 'pause' }),
    });
    expect(res.status).toBe(200);
    expect(seen).toEqual([
      {
        path: '/v1/commands',
        peer: String(process.pid),
        auth: 'Bearer core-token-for-the-hop-test',
      },
    ]);
  }, 30_000);
});
