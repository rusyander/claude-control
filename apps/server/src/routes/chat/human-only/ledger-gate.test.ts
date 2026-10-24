import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import Fastify, { type FastifyInstance, type RouteOptions } from 'fastify';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir, userInfo } from 'node:os';
import { ROUTE_LEDGER } from '../../panel-agent/capability-ledger/capability-ledger.constants.ts';
import type { RouteLedger } from '../../panel-agent/capability-ledger/capability-ledger.types.ts';
import { gateModeOf, humanOnly, type HumanOnlyDeps } from './human-only.ts';
import { setPanelDirs } from './human-only-deps.ts';
import type { PanelDirs } from './throwaway-stand.ts';
import {
  gateHumanRoutes,
  hasStrictGate,
  isHumanRoute,
  UNGATED_HUMAN_ROUTES,
} from './ledger-gate.ts';

/**
 * RF-DS-01..03: каждый маршрут `human:*` журнала возможностей закрыт воротами
 * «только человек» по HTTP — проверено на ЖИВОЙ сборке (`buildRouteTable`,
 * та же, что поднимает сервер), а не на списке. Маршрут человека без строгих
 * ворот — красное; ворота на маршруте, который журнал человеку не отдаёт, —
 * тоже красное, пока он не внесён в `GATED_OUTSIDE_LEDGER` с причиной.
 */

/** Ворота стоят, хотя строка журнала не `human:*` — с причиной. */
const GATED_OUTSIDE_LEDGER: Readonly<Record<string, { mode: 'strict' | 'lenient'; why: string }>> =
  {
    // Настройки правит и агент панели (`action:update_settings` через `app.inject`),
    // а по HTTP — только человек: процесс модели разрешил бы себе всё.
    'PATCH /api/settings': {
      mode: 'strict',
      why: 'agent edits via inject; model over HTTP refused',
    },
    // Список D-n: процессу модели не отдаётся, неузнанному читателю — да.
    'GET /api/chat/deferred': { mode: 'lenient', why: 'list hidden from run processes only' },
    'HEAD /api/chat/deferred': { mode: 'lenient', why: 'HEAD twin of the list' },
  };

/** Порт сервера юнит-проверки — известен после `listen`. */
let unitPort = 0;

/** Звонящий по сокету, которого панель не узнаёт: процесс node вне прогона. */
const STRANGER: HumanOnlyDeps = {
  roots: () => [],
  readTcp: async (wanted) => [
    { localPort: [...wanted][0] as number, remotePort: unitPort, pid: 4242 },
  ],
  readTable: async () => [
    { pid: 1, ppid: 0, created: 1n },
    { pid: 4242, ppid: 1, created: 2n },
  ],
  readFacts: async () => new Map([[4242, { pid: 4242, name: 'node.exe', session: 1 }]]),
  platform: 'win32',
  known: new Set(),
};

describe('ledger gate (unit)', () => {
  const ledger: RouteLedger = {
    'PUT /api/x': 'human:secret',
    'GET /api/x': 'human:secret',
    'GET /api/y': 'action:read_y',
    'POST /api/outside/asks/:id/release': 'human:rights',
  };

  it('a human row is gated, HEAD is judged as its GET, the ungated list is honoured', () => {
    expect(isHumanRoute('PUT', '/api/x', ledger)).toBe(true);
    expect(isHumanRoute('HEAD', '/api/x', ledger)).toBe(true);
    expect(isHumanRoute('GET', '/api/y', ledger)).toBe(false);
    expect(isHumanRoute('GET', '/api/unknown', ledger)).toBe(false);
    expect(isHumanRoute('POST', '/api/outside/asks/:id/release', ledger)).toBe(false);
  });

  it('a strict gate already on the route is recognised, a lenient one is not enough', () => {
    const strict = humanOnly(STRANGER);
    expect(hasStrictGate(strict)).toBe(true);
    expect(hasStrictGate([async () => undefined, strict])).toBe(true);
    expect(hasStrictGate(undefined)).toBe(false);
    expect(hasStrictGate([async () => undefined])).toBe(false);
  });

  it('the hook gates human routes once, refuses a stranger and lets app.inject through', async () => {
    const app = Fastify();
    gateHumanRoutes(app, ledger, STRANGER);
    const seen: Record<string, RouteOptions> = {};
    app.addHook('onRoute', (route) => {
      seen[`${[route.method].flat().join(',')} ${route.url}`] = route;
    });
    let handled = 0;
    app.put('/api/x', async () => ({ ok: (handled += 1) }));
    app.get('/api/x', { preHandler: humanOnly(STRANGER) }, async () => ({ ok: true }));
    app.get('/api/y', async () => ({ ok: true }));
    await app.listen({ port: 0, host: '127.0.0.1' });
    try {
      const strictCount = (key: string) =>
        [seen[key]?.preHandler ?? []].flat().filter((h) => gateModeOf(h) === 'strict').length;
      expect(strictCount('PUT /api/x')).toBe(1);
      expect(strictCount('GET /api/x')).toBe(1);
      expect(strictCount('HEAD /api/x')).toBe(1);
      expect(strictCount('GET /api/y')).toBe(0);
      unitPort = (app.server.address() as { port: number }).port;
      const refused = await fetch(`http://127.0.0.1:${unitPort}/api/x`, { method: 'PUT' });
      expect(refused.status).toBe(403);
      expect(((await refused.json()) as { code: string }).code).toBe('decision_device_unverified');
      expect(handled).toBe(0);
      expect((await app.inject({ method: 'PUT', url: '/api/x' })).statusCode).toBe(200);
      expect(handled).toBe(1);
    } finally {
      await app.close();
    }
  });

  it('the ungated list is pinned: each entry is a human row with a reason', () => {
    expect(Object.keys(UNGATED_HUMAN_ROUTES)).toEqual(['POST /api/outside/asks/:id/release']);
    for (const [key, why] of Object.entries(UNGATED_HUMAN_ROUTES)) {
      expect(ROUTE_LEDGER[key]).toMatch(/^human:/);
      expect(why.length).toBeGreaterThan(20);
    }
  });
});

// ---- the live app assembly ----

interface Seen {
  key: string;
  route: RouteOptions;
}

const seen: Seen[] = [];
let app: FastifyInstance | undefined;
let shutdown: (() => void) | undefined;
let home = '';
let appData = '';
let port = 0;
/** Каталоги, которые задала сама сборка (`gateHumanRoutesFor`). */
let standDirs: (() => PanelDirs | undefined) | undefined;
const savedEnv = {
  CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR,
  USERPROFILE: process.env.USERPROFILE,
  HOME: process.env.HOME,
};

beforeAll(async () => {
  home = realpathSync(mkdtempSync(join(tmpdir(), 'cc-ledger-gate-')));
  const config = join(home, '.claude');
  mkdirSync(config, { recursive: true });
  writeFileSync(join(config, 'settings.json'), '{}');
  process.env.CLAUDE_CONFIG_DIR = config;
  process.env.USERPROFILE = home;
  process.env.HOME = home;
  // Настоящий `~/.claude` владельца тест не читает и не пишет.
  const { detectClaudeLocation } = await import('../../../lib/claude-paths/claude-paths.ts');
  const root = realpathSync(detectClaudeLocation().paths.root);
  if (!root.startsWith(home)) throw new Error(`refusing to assemble over ${root}`);

  const { ServerContext } = await import('../../../context.ts');
  const { createRuntime } = await import('../../../bootstrap/runtime/runtime.ts');
  const { buildRouteTable } = await import('../../../bootstrap/route-table.ts');
  const ctx = new ServerContext();
  appData = ctx.location.paths.appData;
  if (!realpathSync(appData).startsWith(home)) throw new Error(`refusing appData ${appData}`);
  const runtime = createRuntime(ctx, 'http://127.0.0.1:1');
  shutdown = () => runtime.shutdown();
  const instance = Fastify();
  // Тот же объект настроек проходит все хуки `onRoute`: после сборки в нём уже
  // то, что поставили ворота.
  instance.addHook('onRoute', (route) => {
    for (const method of [route.method].flat()) seen.push({ key: `${method} ${route.url}`, route });
  });
  const access = {
    allowedOrigins: new Set<string>(),
    requiresToken: () => false,
    expectedToken: () => '',
  };
  for (const register of buildRouteTable(runtime, access)) register(instance, ctx);
  standDirs = () => ({ config: ctx.location.paths.root, data: ctx.location.paths.appData });
  await instance.listen({ port: 0, host: '127.0.0.1' });
  port = (instance.server.address() as { port: number }).port;
  app = instance;
}, 120_000);

afterAll(async () => {
  setPanelDirs(undefined);
  shutdown?.();
  await app?.close();
  for (const [name, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  rmSync(home, { recursive: true, force: true });
});

const ledgerKey = (key: string) => key.replace(/^HEAD /, 'GET ');
const modeOf = (route: RouteOptions) =>
  [route.preHandler ?? []].flat().map(gateModeOf).find(Boolean);

describe('ledger gate against the live route table', () => {
  it('every human:* route of the app carries the strict gate', () => {
    const human = seen.filter(({ key }) => ROUTE_LEDGER[ledgerKey(key)]?.startsWith('human:'));
    const open = human
      .filter(({ key }) => !(ledgerKey(key) in UNGATED_HUMAN_ROUTES))
      .filter(({ route }) => !hasStrictGate(route.preHandler))
      .map(({ key }) => key);
    expect(open).toEqual([]);
    // Сборка, где маршрутов человека нет, ничего бы не доказала.
    expect(human.length).toBeGreaterThan(100);
    for (const key of [
      'PUT /api/integrations/telegram/answers',
      'POST /api/integrations/telegram/answers/restart',
      'POST /api/settings/import',
      'POST /api/chat/split/:parent/review-decision',
    ]) {
      expect(human.some((entry) => entry.key === key)).toBe(true);
    }
  });

  it('a gated route the ledger does not give to the human is listed with a reason, both ways', () => {
    const outside = seen
      .filter(({ route }) => modeOf(route))
      .filter(({ key }) => !ROUTE_LEDGER[ledgerKey(key)]?.startsWith('human:'))
      .map(({ key, route }) => [key, modeOf(route)]);
    const listed = Object.entries(GATED_OUTSIDE_LEDGER).map(([key, { mode }]) => [key, mode]);
    expect(Object.fromEntries(outside)).toEqual(Object.fromEntries(listed));
  });

  it('the ungated human routes exist in the app and stay without a gate', () => {
    for (const key of Object.keys(UNGATED_HUMAN_ROUTES)) {
      const entry = seen.find((item) => item.key === key);
      expect(entry, key).toBeDefined();
      expect(modeOf(entry!.route)).toBeUndefined();
    }
  });

  const call = async (method: string, url: string, body: unknown) => {
    const response = await fetch(`http://127.0.0.1:${port}${url}`, {
      method,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    return { status: response.status, code: ((await response.json()) as { code?: string }).code };
  };

  it('over a real socket a non-browser caller is refused before the handler runs', async () => {
    const answers = join(appData, 'telegram-answers.json');
    const before = existsSync(answers) ? readFileSync(answers, 'utf8') : undefined;
    // Каталог конфигурации вне temp: шва нет, судится сам процесс теста (не браузер).
    setPanelDirs(() => ({ config: process.cwd(), data: appData }));
    try {
      const results = [
        await call('PUT', '/api/integrations/telegram/answers', { enabled: true, ownerId: 12345 }),
        await call('POST', '/api/integrations/telegram/answers/restart', {}),
        await call('POST', '/api/settings/import', { settings: { chatAutoMode: true } }),
        await call('POST', '/api/chat/split/p1/review-decision', { decision: 'approve' }),
      ];
      // 403 — процесс теста не браузер; 503 — ОС не ответила (тоже отказ, не пропуск).
      for (const result of results) {
        expect([403, 503]).toContain(result.status);
        expect(result.code).toMatch(/^decision_(device_unverified|peer_unknown)$/);
      }
    } finally {
      setPanelDirs(standDirs);
    }
    const after = existsSync(answers) ? readFileSync(answers, 'utf8') : undefined;
    expect(after).toBe(before);
  }, 60_000);

  it('throwaway-stand seam: both dirs in OS temp let the panel line through; one real dir or a junction out does not', async () => {
    const restart = () => call('POST', '/api/integrations/telegram/answers/restart', {});
    // Как собрано: конфигурация и данные — во временном доме теста.
    expect((await restart()).status).toBe(200);
    const link = join(home, 'link-out');
    symlinkSync(process.cwd(), link, 'junction');
    const variants = [
      { config: process.cwd(), data: appData },
      { config: join(home, '.claude'), data: process.cwd() },
      { config: link, data: appData },
      { config: join(home, '.claude'), data: join(home, 'missing') },
      // Пропавший каталог конфигурации вне temp — шва нет (внутри temp — стенд без Claude).
      { config: join(process.cwd(), 'missing-claude'), data: appData },
      { config: join(link, 'missing-claude'), data: appData },
      // Настоящий `~/.claude` человека (только realpath, без записи) — шва нет.
      { config: join(userInfo().homedir, '.claude'), data: appData },
    ];
    try {
      for (const dirs of variants) {
        setPanelDirs(() => dirs);
        const refused = await restart();
        expect(refused.status, JSON.stringify(dirs)).not.toBe(200);
        expect(refused.code).toMatch(/^decision_(device_unverified|peer_unknown)$/);
      }
      // Стенд «машина без Claude»: каталога конфигурации нет, его путь — в temp.
      setPanelDirs(() => ({ config: join(home, 'no-claude', '.claude'), data: appData }));
      expect((await restart()).status).toBe(200);
    } finally {
      setPanelDirs(standDirs);
    }
  }, 60_000);
});
