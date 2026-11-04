import { createServer, type Server } from 'node:http';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { CoreSupervisorStatus } from '@agentdeck/contracts/core/supervisor';
import { processStartOf } from '../../lib/listen-identity/listen-identity.ts';
import { createCoreProxyRoutes, type CoreProxySupervisor } from './core-proxy-routes.ts';

/**
 * Прокладка при надзоре ядра (этап 10): ядра нет, а панель его поднимает — запрос ждёт подъёма
 * и уходит ядру; не дождался — `core-starting`; надзор сдался — `core-fault`. Без надзора —
 * прежний `core-absent`. Настоящие чтения ОС, «ядро» — заглушка в этом процессе.
 */

const TOKEN = 'core-token-for-the-supervisor-test';

let home = '';
let stub: Server | undefined;
let stubPort = 0;
let ownStart = '';
const seen: string[] = [];
const panels: FastifyInstance[] = [];

function writeRow() {
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
  };
  writeFileSync(join(home, 'procs.json'), JSON.stringify({ v: 1, cores: [entry], servers: [] }));
}

function status(state: CoreSupervisorStatus['state']): CoreSupervisorStatus {
  return {
    state,
    pid: null,
    restarts: state === 'fault' ? 5 : 0,
    lastExit: null,
    nextRetryAt: null,
    logTail: [],
    autostart: 'off',
  };
}

async function panelWith(supervisor?: CoreProxySupervisor): Promise<string> {
  const panel = Fastify({ logger: false });
  createCoreProxyRoutes({
    home: () => home,
    readTcp: async () => undefined,
    ...(supervisor ? { supervisor } : {}),
    startingWaitMs: 2_000,
  })(panel);
  await panel.listen({ host: '127.0.0.1', port: 0 });
  panels.push(panel);
  return `http://127.0.0.1:${(panel.server.address() as AddressInfo).port}`;
}

beforeAll(async () => {
  home = mkdtempSync(join(tmpdir(), 'cc-core-supervised-'));
  writeFileSync(join(home, 'token'), TOKEN);
  stub = createServer((req, res) => {
    seen.push(req.url ?? '');
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ ok: true }));
  });
  await new Promise<void>((done) => stub!.listen(0, '127.0.0.1', done));
  stubPort = (stub.address() as AddressInfo).port;
  const start = await processStartOf(process.pid);
  if (!start) throw new Error('own process start is unreadable on this OS');
  ownStart = start;
}, 30_000);

afterAll(async () => {
  for (const panel of panels) await panel.close();
  await new Promise((done) => (stub ? stub.close(done) : done(undefined)));
  rmSync(home, { recursive: true, force: true });
});

beforeEach(() => {
  seen.length = 0;
  rmSync(join(home, 'procs.json'), { force: true });
});

describe('core proxy under the panel supervisor (stage 10)', () => {
  it('no supervisor and no core → core-absent (developer runs the core)', async () => {
    const url = await panelWith();
    const res = await fetch(`${url}/api/core/tasks`);
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ code: 'core-absent' });
  });

  it('core is starting: the request waits for it and reaches the core', async () => {
    let waited = 0;
    const url = await panelWith({
      status: () => status('starting'),
      whenUp: async () => {
        waited += 1;
        writeRow();
        return true;
      },
    });
    const res = await fetch(`${url}/api/core/tasks`);
    expect(waited).toBe(1);
    expect(res.status).toBe(200);
    expect(seen).toEqual(['/v1/tasks']);
  });

  it('core does not come up in the wait → core-starting, nothing sent', async () => {
    const url = await panelWith({ status: () => status('restarting'), whenUp: async () => false });
    const res = await fetch(`${url}/api/core/tasks`);
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ code: 'core-starting' });
    expect(seen).toEqual([]);
  });

  it('supervisor gave up → core-fault at once, no wait', async () => {
    let waited = 0;
    const url = await panelWith({
      status: () => status('fault'),
      whenUp: async () => {
        waited += 1;
        return false;
      },
    });
    const res = await fetch(`${url}/api/core/tasks`);
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ code: 'core-fault' });
    expect(waited).toBe(0);
  });

  it('a live verified core is forwarded without asking the supervisor', async () => {
    writeRow();
    let waited = 0;
    const url = await panelWith({
      status: () => status('up'),
      whenUp: async () => {
        waited += 1;
        return true;
      },
    });
    const res = await fetch(`${url}/api/core/tasks`);
    expect(res.status).toBe(200);
    expect(waited).toBe(0);
  });
});
