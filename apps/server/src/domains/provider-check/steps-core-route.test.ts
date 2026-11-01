import { createServer, type Server } from 'node:http';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { ProviderCheckResult } from '@agentdeck/contracts';
import type { RouteView } from '@agentdeck/contracts/core/panel-api';
import type { ServerContext } from '../../context.ts';
import { CORE_HOME_ENV } from '../../lib/hop-recorder.mjs';
import {
  createCoreIdentityDeps,
  processStartOf,
} from '../../lib/listen-identity/listen-identity.ts';
import { registerProviderCheckRoutes } from '../../routes/provider-check-routes.ts';
import { levelOf } from './run.ts';
import { checkCoreRoute, createCoreRoutesReader } from './steps-core-route.ts';

/**
 * Шаг «маршрут ядра» (core-s9). «Ядро» — настоящий HTTP-сервер в этом процессе, отдающий
 * `/v1/routes`; строка `procs.json` и токен лежат во временном доме; сверка строки — настоящими
 * чтениями ОС (слушатель порта, старт процесса), ничего не подменено. Последний тест идёт через
 * настоящую ручку `POST /api/providers/:id/check` — то, что видит панель.
 */

const TOKEN = 'core-token-for-the-route-step';

let home = '';
let stub: Server | undefined;
let stubPort = 0;
let ownStart = '';
let routes: RouteView[] = [];
let status = 200;
const seen: { path?: string; auth?: string }[] = [];

const caps = {
  dialects: [],
  tools: true,
  images: false,
  streaming: true,
  maskable: false,
  offline: false,
  binding: { via: 'cli-login' as const, adapter: 'claude' },
  limitsToTell: false,
};
function route(id: string, extra: Partial<RouteView> = {}): RouteView {
  return {
    id,
    kind: 'cli-login',
    credential: null,
    caps,
    price: { unit: 'window' },
    limit: { kind: 'window', source: 'in-band-event' },
    models: null,
    exhausted: false,
    ...extra,
  };
}

function writeRow(row: Record<string, unknown> = {}) {
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

// Одна фабрика сверки на весь файл, как у ручки: память живости у неё своя.
const identity = createCoreIdentityDeps();
const reader = () => createCoreRoutesReader({ home: () => home, identity });

beforeAll(async () => {
  home = mkdtempSync(join(tmpdir(), 'cc-core-route-step-'));
  writeFileSync(join(home, 'token'), TOKEN);
  stub = createServer((req, res) => {
    seen.push({ path: req.url, auth: req.headers.authorization });
    res.statusCode = status;
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ routes }));
  });
  await new Promise<void>((done) => stub!.listen(0, '127.0.0.1', done));
  stubPort = (stub.address() as AddressInfo).port;
  const start = await processStartOf(process.pid);
  if (!start) throw new Error('own process start is unreadable on this OS');
  ownStart = start;
}, 30_000);

afterAll(async () => {
  await new Promise((done) => (stub ? stub.close(done) : done(undefined)));
  rmSync(home, { recursive: true, force: true });
});

beforeEach(() => {
  seen.length = 0;
  status = 200;
  routes = [];
  writeRow();
});

describe('checkCoreRoute against a verified core', () => {
  it('credential present and not exhausted passes; the bearer reached /v1/routes', async () => {
    routes = [route('cli-login:claude', { credential: { kind: 'cli-store', present: true } })];
    const got = await checkCoreRoute('claude', reader());
    expect(got.status).toBe('pass');
    expect(got.id).toBe('coreRoute');
    expect(got.detail).toContain('cli-login:claude');
    expect(seen).toEqual([{ path: '/v1/routes', auth: `Bearer ${TOKEN}` }]);
  }, 30_000);

  it('an exhausted route warns even with a credential', async () => {
    routes = [
      route('cli-login:claude', {
        credential: { kind: 'cli-store', present: true },
        exhausted: true,
      }),
    ];
    const got = await checkCoreRoute('claude', reader());
    expect(got.status).toBe('warn');
    expect(got.detail).toContain('исчерпан');
  }, 30_000);

  it('a route whose credential is absent warns', async () => {
    routes = [route('cli-login:claude', { credential: { kind: 'cli-store', present: false } })];
    const got = await checkCoreRoute('claude', reader());
    expect(got.status).toBe('warn');
    expect(got.detail).toContain('нет доступа');
  }, 30_000);

  it('a credential the core never read is skipped with the reason, not warned', async () => {
    routes = [route('cli-login:claude')];
    const got = await checkCoreRoute('claude', reader());
    expect(got.status).toBe('skipped');
    expect(got.detail).toContain('хранилище входа CLI');
  }, 30_000);

  it('only the route of THIS provider counts; none → skipped naming the route', async () => {
    routes = [route('cli-login:qwen', { credential: { kind: 'cli-store', present: true } })];
    const got = await checkCoreRoute('claude', reader());
    expect(got.status).toBe('skipped');
    expect(got.detail).toContain('cli-login:claude');
  }, 30_000);

  it('a core that answers with an error is skipped as unreachable', async () => {
    status = 500;
    const got = await checkCoreRoute('claude', reader());
    expect(got.status).toBe('skipped');
    expect(got.detail).toContain('HTTP 500');
  }, 30_000);
});

describe('checkCoreRoute without a provable core', () => {
  it('no procs.json → skipped «not running»', async () => {
    rmSync(join(home, 'procs.json'));
    const got = await checkCoreRoute('claude', reader());
    expect(got.status).toBe('skipped');
    expect(got.detail).toContain('не запущено');
    expect(seen).toEqual([]);
  });

  it('a row the OS does not confirm gets no request — the token never leaves', async () => {
    // Наш живой процесс, но с чужим стартом: строка не подтверждена, процесс есть.
    writeRow({ pidStart: `${ownStart}9` });
    routes = [route('cli-login:claude', { credential: { kind: 'cli-store', present: true } })];
    const got = await checkCoreRoute('claude', reader());
    expect(got.status).toBe('skipped');
    expect(got.detail).toContain('не подтвердила ОС');
    expect(seen).toEqual([]);
  }, 30_000);

  it('a skipped core step never lowers the level', () => {
    expect(
      levelOf([
        { id: 'cli', status: 'pass', detail: '' },
        { id: 'coreRoute', status: 'skipped', detail: '' },
        { id: 'assistant', status: 'pass', detail: '' },
      ]),
    ).toBe('verified');
    expect(
      levelOf([
        { id: 'coreRoute', status: 'warn', detail: '' },
        { id: 'assistant', status: 'pass', detail: '' },
      ]),
    ).toBe('partial');
  });
});

describe('POST /api/providers/:id/check', () => {
  it('the panel route reads the core from its home and reports the step', async () => {
    routes = [route('cli-login:claude', { credential: { kind: 'cli-store', present: true } })];
    const claudeDir = join(home, 'claude-config');
    mkdirSync(claudeDir, { recursive: true });
    const saved: ProviderCheckResult[] = [];
    const ctx = {
      location: { paths: { appData: join(home, 'app-data') } },
      store: {
        getSettings: () => ({ claudeDirOverride: claudeDir }),
        saveProviderCheck: (result: ProviderCheckResult) => saved.push(result),
        getProviderChecks: () => ({}),
      },
      models: { current: () => ({ models: [] }) },
    } as unknown as ServerContext;
    const previous = process.env[CORE_HOME_ENV];
    process.env[CORE_HOME_ENV] = home;
    const app = Fastify({ logger: false });
    try {
      registerProviderCheckRoutes(app, ctx);
      const reply = await app.inject({
        method: 'POST',
        url: '/api/providers/claude/check',
        payload: { assistant: false },
      });
      expect(reply.statusCode).toBe(200);
      const body = reply.json<ProviderCheckResult>();
      const step = body.steps.find((item) => item.id === 'coreRoute');
      expect(step?.status).toBe('pass');
      expect(step?.detailCode).toBe('checks-core-route-ok');
      expect(seen).toEqual([{ path: '/v1/routes', auth: `Bearer ${TOKEN}` }]);
      expect(saved[0]?.steps.some((item) => item.id === 'coreRoute')).toBe(true);
    } finally {
      await app.close();
      if (previous === undefined) delete process.env[CORE_HOME_ENV];
      else process.env[CORE_HOME_ENV] = previous;
    }
  }, 60_000);
});
