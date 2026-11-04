import { execFileSync } from 'node:child_process';
import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  CHAT_START_CARRY_REFUSED,
  CHAT_START_ROUTE,
  parseEstimateBody,
} from '@agentdeck/contracts/core/estimate';
import type { Platform } from '@agentdeck/contracts';
import { defaultOurRules, defaultPlatformRules } from '@agentdeck/contracts/platform';
import { defaultPlatformTransport } from '@agentdeck/contracts/platform-transport';
import { AppStore } from '../../lib/app-store/app-store.ts';
import { writePlatform } from '../../domains/platform/store/store.ts';
import type { ServerContext } from '../../context.ts';
import { processStartOf } from '../../lib/listen-identity/listen-identity.ts';
import { randomUUID7 } from '../../domains/core-ask/core-ask.ts';
import { registerChatStartRoute } from '../../routes/core-proxy/chat-start-route.ts';
import { memoryContours } from '../../domains/platform/contours/__fixtures__/memory-contours.ts';
import { writeLayerMode } from '../../domains/local-layer/local-layer.ts';
import { createRuntime, type Runtime } from './runtime.ts';

/**
 * Старт чата ядра из веба (этап 10, G13) на проводке сборки: ручка `/api/chat/core-start`,
 * НАСТОЯЩИЙ перенос сборки (`runtime.chatStartCarry`: реестр чата `compose` → `runRoute` →
 * `KitService` на диске, строка о тестах; чужой CLI — `createForeignCarry`), настоящая сверка
 * строки ядра. Подменено только ядро — слушатель в этом процессе, который записывает тело оценки:
 * его разбирает тот же разборщик контрактов, что и ядро (`parseEstimateBody`), а дальше путь
 * `task.created.session` → argv переходника доказан тестом ядра
 * `conductor-wiring/session-carry.integration.test.ts`.
 *
 * До G13 веб слал оценку ядру напрямую: в теле не было ни `session`, ни `env` — набор, наши слои
 * и строка о тестах до нового разговора не доходили.
 */

const TOKEN = 'core-token-for-the-chat-start-test';

interface Seen {
  url: string;
  headers: IncomingHttpHeaders;
  body: unknown;
}

let home = '';
let stub: Server | undefined;
let stubPort = 0;
let ownStart = '';
const seen: Seen[] = [];

beforeAll(async () => {
  home = mkdtempSync(join(tmpdir(), 'cc-chat-start-core-'));
  writeFileSync(join(home, 'token'), TOKEN);
  stub = createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk: Buffer) => (raw += chunk.toString('utf8')));
    req.on('end', () => {
      seen.push({ url: req.url ?? '', headers: req.headers, body: raw ? JSON.parse(raw) : null });
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ state: 'ready', taskId: 'stub-task', preflight: [] }));
    });
  });
  await new Promise<void>((done) => stub!.listen(0, '127.0.0.1', done));
  stubPort = (stub.address() as AddressInfo).port;
  const start = await processStartOf(process.pid);
  if (!start) throw new Error('own process start is unreadable on this OS');
  ownStart = start;
  writeFileSync(
    join(home, 'procs.json'),
    JSON.stringify({
      v: 1,
      cores: [
        {
          build: 'test',
          pid: process.pid,
          pidStart: ownStart,
          bootId: 'boot',
          port: stubPort,
          url: `http://127.0.0.1:${stubPort}`,
          startedAt: Date.now(),
          home,
          portDecision: { rejected: [] },
        },
      ],
      servers: [],
    }),
  );
}, 30_000);

afterAll(async () => {
  await new Promise((done) => (stub ? stub.close(done) : done(undefined)));
  rmSync(home, { recursive: true, force: true });
});

describe('web core-chat start carries the panel layer (runtime chatStartCarry → core estimate)', () => {
  let root: string;
  let project: string;
  let runtime: Runtime;
  let app: FastifyInstance;
  let store: AppStore;

  beforeEach(async () => {
    seen.length = 0;
    root = realpathSync.native(mkdtempSync(join(tmpdir(), 'cc-rt-chat-start-')));
    const appData = join(root, 'agentdeck');
    mkdirSync(appData, { recursive: true });
    project = join(root, 'project');
    mkdirSync(project);
    writeFileSync(join(root, 'settings.json'), '{}', 'utf8');
    const ctx = {
      store: new AppStore(appData),
      location: {
        paths: {
          root,
          appData,
          settings: join(root, 'settings.json'),
          settingsLocal: join(root, 'settings.local.json'),
          claudeMd: join(root, 'CLAUDE.md'),
          secretsEnv: join(root, '.mcp-secrets.env'),
          skills: join(root, 'skills'),
          hooks: join(root, 'hooks'),
          mcpConfig: join(root, '.claude.json'),
        },
      },
      backupDir: join(root, 'backups'),
      pricing: { current: () => ({ entries: [] }) },
      models: { current: () => ({ models: [] }) },
    } as unknown as ServerContext;
    process.env.AGENTDECK_LOCAL_MODELS_DIR = join(root, 'local-models');
    runtime = createRuntime(ctx, 'http://127.0.0.1:1', { contours: memoryContours() });
    app = Fastify();
    registerChatStartRoute(app, {
      home: () => home,
      readTcp: async () => undefined,
      carry: runtime.chatStartCarry,
      routes: runtime.chatStartRoutes,
    });
    await app.ready();
    store = ctx.store;
  });

  afterEach(async () => {
    runtime.chatRuns.stopAll();
    runtime.shutdown();
    delete process.env.AGENTDECK_LOCAL_MODELS_DIR;
    await app.close();
    rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });

  const page = randomUUID7();
  const chatFields = (extra: Record<string, unknown> = {}) => ({
    title: 'скажи ок',
    request: 'скажи ок',
    repos: [{ path: project, baseRef: null }],
    scenario: { preset: 'chat' },
    launchPolicy: 'confirm',
    ciWait: false,
    placement: { kind: 'in-place', grant: { project, ops: ['edit'] } },
    ...extra,
  });

  async function start(cli: string, fields = chatFields(), proof: Record<string, string> = {}) {
    return app.inject({
      method: 'POST',
      url: CHAT_START_ROUTE,
      payload: {
        cmdId: randomUUID7(),
        cli,
        fields,
        proof: { nonce: 'page-nonce', page, ...proof },
      },
    });
  }

  const kitDir = (mode: string) =>
    join(root, 'agentdeck', 'kit', 'effective', mode, 'agentdeck-kit');

  it('Claude, kit «ours»: plugin + narrowed sources + kit vars + Tests line reach the core estimate', async () => {
    runtime.kit.setMode('claude', 'ours');
    const res = await start('claude');
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ taskId: 'stub-task' });
    expect(seen).toHaveLength(1);
    const got = seen[0]!;
    expect(got.url).toBe('/v1/estimate');
    // Тело принимает тот же разборщик, что у ядра: имена `env` совпадают с ключами значений.
    const parsed = parseEstimateBody(got.body);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const { fields, env, proof } = parsed.body;
    expect(fields.session?.plugins).toEqual([kitDir('ours')]);
    expect(fields.session?.settingSources).toEqual(['project', 'local']);
    expect(fields.session?.append).toContain('no e2e folder yet');
    expect(env?.AGENTDECK_KIT_VARIANT).toBe('standard');
    expect(env?.AGENTDECK_TESTS_NOTE).toBe('1');
    expect([...(fields.session?.env ?? [])].sort()).toEqual(Object.keys(env ?? {}).sort());
    // Доказательство страницы — как прислал веб: панель его не чеканит и не подменяет.
    expect(proof).toEqual({ nonce: 'page-nonce', page });
    expect(got.headers['x-agentdeck-peer-pid']).toBe('0');
    expect(got.headers.authorization).toBe(`Bearer ${TOKEN}`);
  });

  it('Claude, kit «global»: only the guards overlay plugin, no kit variant', async () => {
    runtime.kit.setMode('claude', 'global');
    const res = await start('claude');
    expect(res.statusCode).toBe(200);
    const parsed = parseEstimateBody(seen[0]?.body);
    if (!parsed.ok) throw new Error('estimate body does not parse');
    expect(parsed.body.fields.session?.settingSources).toBeUndefined();
    expect(parsed.body.env?.AGENTDECK_KIT_VARIANT).toBeUndefined();
    expect(parsed.body.fields.session?.append).toContain('no e2e folder yet');
  });

  // Резолвер локального слоя поставлен сборкой (s10 G14 p6): карточка «Локальный слой» «Вкл.»
  // у проекта → слой едет полем `session.localLayer`, источник `project` снят.
  it('Claude, project local layer «on»: the layer rides session.localLayer, the project source is dropped', async () => {
    runtime.kit.setMode('claude', 'global');
    const git = (...args: string[]) =>
      execFileSync('git', args, { cwd: project, stdio: ['ignore', 'pipe', 'ignore'] });
    git('init', '-q');
    git('config', 'user.email', 't@example.com');
    git('config', 'user.name', 't');
    writeFileSync(join(project, '.gitignore'), '.agent/\n');
    writeFileSync(join(project, 'CLAUDE.md'), '# Team\n\nRT_LOCAL_LAYER_MARK\n');
    git('add', '-A');
    git('commit', '-qm', 'team');
    writeLayerMode(project, 'on');
    const res = await start('claude');
    expect(res.statusCode).toBe(200);
    const parsed = parseEstimateBody(seen[0]?.body);
    if (!parsed.ok) throw new Error('estimate body does not parse');
    const session = parsed.body.fields.session;
    expect(session?.settingSources).toEqual(['user', 'local']);
    expect(session?.localLayer?.instructions).toContain('RT_LOCAL_LAYER_MARK');

    // «Выкл.» — ни поля, ни снятия источника.
    writeLayerMode(project, 'off');
    seen.length = 0;
    await start('claude');
    const off = parseEstimateBody(seen[0]?.body);
    if (!off.ok) throw new Error('estimate body does not parse');
    expect(off.body.fields.session?.localLayer).toBeUndefined();
    expect(off.body.fields.session?.settingSources).toBeUndefined();
  });

  it('foreign CLI (Codex, kit «hybrid»): kit rules + Tests line as append, no plugin', async () => {
    runtime.kit.setMode('codex', 'hybrid');
    const res = await start('codex');
    expect(res.statusCode).toBe(200);
    const parsed = parseEstimateBody(seen[0]?.body);
    if (!parsed.ok) throw new Error('estimate body does not parse');
    const session = parsed.body.fields.session;
    expect(session?.plugins).toBeUndefined();
    expect(session?.append).toContain('no e2e folder yet');
    expect((session?.append ?? '').length).toBeGreaterThan(1_000);
  });

  // До G13 веб-старт не слал `set-route`: контур «по возможности» с галочкой «Чат» новый разговор
  // из веба не вёл (ход реестра чата `core-run.ts` шлёт его сам). Маршрут решает панель тем же
  // `coreContourRoutes`, ответ несёт его вебу, ядру в оценку он не уходит.
  it('best-effort contour, box «Чат» / `foreign:codex` ticked → the reply carries allowedRoutes for that CLI; box off → none', async () => {
    const platform = {
      id: 'company-dev',
      title: 'Company · dev',
      driver: 'enterprise-platform',
      baseUrl: 'https://api.dev.example.com',
      enabled: true,
      mode: 'best-effort',
      budgetUsd: 0,
      capabilities: [],
      targets: [],
      consumers: ['chat', 'foreign:codex'],
      projectPaths: [],
      agents: [],
      budgetSince: '',
      toolShim: true,
      contourPrompt: true,
      defaultModel: 'corp-large',
      consumerModels: {},
      modelMap: {},
      rules: { platform: defaultPlatformRules(), ours: defaultOurRules() },
      caCertPath: '',
      transport: defaultPlatformTransport(),
    } satisfies Platform;
    writePlatform(store, platform);
    store.updateSettings({ activePlatformId: platform.id });
    const gateway = { kind: 'gateway', id: 'gateway:company-dev' };

    const claude = await start('claude');
    expect(claude.statusCode).toBe(200);
    expect(claude.json()).toMatchObject({
      taskId: 'stub-task',
      allowedRoutes: [{ adapter: 'claude', route: gateway, modelPattern: 'corp-large' }],
    });
    const codex = await start('codex');
    expect(codex.json()).toMatchObject({
      allowedRoutes: [{ adapter: 'codex', route: gateway, modelPattern: 'corp-large' }],
    });
    // Ядру уходит оценка без маршрута: его ставит `set-route` веба, судом ядра.
    expect(JSON.stringify(seen.map((s) => s.body))).not.toContain('gateway:company-dev');

    writePlatform(store, { ...platform, consumers: [] });
    const off = await start('claude');
    expect(off.statusCode).toBe(200);
    expect(off.json()).not.toHaveProperty('allowedRoutes');
  });

  it('client-sent session, device signature, non-chat estimate → refused, nothing sent to the core', async () => {
    const owned = await start('claude', chatFields({ session: { append: 'mine' } }));
    expect(owned.statusCode).toBe(400);
    expect(owned.json()).toMatchObject({ code: 'chat-start-session-owned' });
    const signed = await start('claude', chatFields(), { signature: 'sig' });
    expect(signed.statusCode).toBe(400);
    expect(signed.json()).toMatchObject({ code: 'chat-start-signed' });
    const copy = await start('claude', chatFields({ placement: { kind: 'copy' } }));
    expect(copy.statusCode).toBe(400);
    expect(copy.json()).toMatchObject({ code: 'chat-start-not-chat' });
    expect(seen).toEqual([]);
  });

  it('a panel layer that does not fit → 422 by name, the core is not asked', async () => {
    const refusing = Fastify();
    registerChatStartRoute(refusing, {
      home: () => home,
      readTcp: async () => undefined,
      carry: () => ({ ok: false, reason: 'panel flag --mcp-config has no core session field' }),
    });
    const res = await refusing.inject({
      method: 'POST',
      url: CHAT_START_ROUTE,
      payload: { cmdId: randomUUID7(), cli: 'claude', fields: chatFields(), proof: { page } },
    });
    await refusing.close();
    expect(res.statusCode).toBe(422);
    expect(res.json()).toMatchObject({
      code: CHAT_START_CARRY_REFUSED,
      detail: 'panel flag --mcp-config has no core session field',
    });
    expect(seen).toEqual([]);
  });
});
