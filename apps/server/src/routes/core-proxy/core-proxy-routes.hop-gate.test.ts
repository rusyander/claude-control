import { createServer, type Server } from 'node:http';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHopGate } from '../../domains/core-proxy/hop-gate.ts';
import { processStartOf } from '../../lib/listen-identity/listen-identity.ts';
import { writeHopRecord } from '../../lib/hop-recorder.mjs';
import { readTcpTable } from '../../lib/peer-process/peer-process.ts';
import { createCoreProxyRoutes } from './core-proxy-routes.ts';

/**
 * P131: первая команда не уходит ядру раньше, чем сторож записал этот сервер звеном. Прокладка —
 * настоящая (таблица TCP, сверка строки ядра), ядро — заглушка, считающая пришедшие запросы;
 * итог записи сторожа — настоящий файл в формате `writeHopRecord`. Чтение (GET) не ждёт: подписи
 * ему не нужно.
 */

const CHANNEL = 'test-supervisor-channel';
let home = '';
let recordFile = '';
let core: Server | undefined;
let panel: FastifyInstance | undefined;
let panelPort = 0;
const seen: string[] = [];

beforeAll(async () => {
  home = mkdtempSync(join(tmpdir(), 'cc-hop-gate-'));
  recordFile = join(home, 'core-hops.json');
  core = createServer((req, res) => {
    seen.push(`${req.method} ${req.url}`);
    req.resume();
    req.on('end', () => {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ ok: true }));
    });
  });
  await new Promise<void>((done) => core!.listen(0, '127.0.0.1', done));
  const corePort = (core.address() as AddressInfo).port;
  writeFileSync(join(home, 'token'), 'core-token-for-the-gate-test');
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
          supervisor: CHANNEL,
          portDecision: { rejected: [] },
        },
      ],
      servers: [],
    }),
  );
  panel = Fastify({ logger: false });
  createCoreProxyRoutes({
    home: () => home,
    readTcp: (wanted) => readTcpTable(wanted),
    hopGate: createHopGate({ file: recordFile, pid: process.pid, timeoutMs: 20_000, pollMs: 20 }),
  })(panel);
  await panel.listen({ host: '127.0.0.1', port: 0 });
  panelPort = (panel.server.address() as AddressInfo).port;
}, 60_000);

afterAll(async () => {
  await panel?.close();
  await new Promise((done) => (core ? core.close(done) : done(undefined)));
  rmSync(home, { recursive: true, force: true });
});

const wait = (ms: number) => new Promise((done) => setTimeout(done, ms));

describe('core proxy waits for the hop record (P131)', () => {
  it('a command is held until the watcher records this server for the core channel; a read is not held', async () => {
    seen.length = 0;
    const read = await fetch(`http://127.0.0.1:${panelPort}/api/core/health`);
    expect(read.status).toBe(200);
    expect(seen).toEqual(['GET /v1/health']);

    const sent = fetch(`http://127.0.0.1:${panelPort}/api/core/commands`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ kind: 'pause' }),
    });
    // Записи нет — команда стоит у ворот, ядро её не видело.
    await wait(600);
    expect(seen).toEqual(['GET /v1/health']);
    // Запись другого pid для этого канала ворот не открывает.
    writeHopRecord(recordFile, [process.pid + 1], {
      [CHANNEL]: { ok: true, accepted: [process.pid + 1], refused: [], recordedAt: 1 },
    });
    await wait(300);
    expect(seen).toEqual(['GET /v1/health']);
    writeHopRecord(recordFile, [process.pid], {
      [CHANNEL]: { ok: true, accepted: [process.pid], refused: [], recordedAt: 1 },
    });
    const res = await sent;
    expect(res.status).toBe(200);
    expect(seen).toEqual(['GET /v1/health', 'POST /v1/commands']);
  }, 30_000);
});
