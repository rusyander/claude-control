import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { createServer } from 'node:net';
import { createServer as createHttpServer } from 'node:http';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { PanelActionResult, PanelPendingAction } from '@agentdeck/contracts/panel-agent';
import { PANEL_AGENT_HEADER } from '@agentdeck/contracts/panel-agent';
import { AppStore } from '../../lib/app-store.ts';
import type { ServerContext } from '../../context.ts';
import { registerAccessGate } from '../../lib/access-gate.ts';
import { registerEmptyBodyGuard } from '../../lib/empty-body.ts';
import { createEventHub } from '../../lib/event-hub.ts';
import { allowedOrigins } from '../../lib/origin-guard.ts';
import { DlpProxy } from '../../domains/dlp/DlpProxy.ts';
import { PanelPendingActions } from '../../domains/panel-agent/pending.ts';
import { registerConfigRoutes } from '../config-routes.ts';
import { registerEntityRoutes } from '../entity-routes.ts';
import { registerGroupRoutes } from '../group-routes.ts';
import { registerEndpointRoutes } from '../endpoint-routes.ts';
import { registerDlpRoutes } from '../dlp-routes.ts';
import { registerIntegrationsRoutes } from '../integrations-routes.ts';
import { registerPanelAgentRoutes } from './panel-agent-routes.ts';

/**
 * Действия по состоянию панели (группы, настройки, провайдер, эндпоинты, DLP,
 * интеграции) на настоящих маршрутах и ВРЕМЕННОМ каталоге. Доказательство —
 * state.json, settings.json и живой слушатель прокси, а не ответ действия.
 */
const ORIGIN = 'http://localhost:8888';

const freePort = (): Promise<number> =>
  new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      server.close(() => resolve(typeof address === 'object' && address ? address.port : 0));
    });
  });

describe('panel-agent actions: panel state', () => {
  let base: string;
  let root: string;
  let appData: string;
  let store: AppStore;
  let proxy: DlpProxy;
  let pending: PanelPendingActions;
  let app: FastifyInstance;

  const paths = () => ({
    root,
    appData,
    settings: join(root, 'settings.json'),
    settingsLocal: join(root, 'settings.local.json'),
    claudeMd: join(root, 'CLAUDE.md'),
    secretsEnv: join(root, '.mcp-secrets.env'),
    skills: join(root, 'skills'),
    hooks: join(root, 'hooks'),
    mcpConfig: join(base, '.claude.json'),
  });
  /** Состояние с диска: новое хранилище, а не память маршрута. */
  const disk = () => new AppStore(appData);
  const settingsJson = () =>
    JSON.parse(readFileSync(paths().settings, 'utf8')) as { env?: Record<string, string> };

  beforeEach(async () => {
    base = mkdtempSync(join(tmpdir(), 'cc-agent-app-'));
    root = join(base, '.claude');
    appData = join(root, 'agentdeck');
    mkdirSync(join(root, 'skills', 'review'), { recursive: true });
    mkdirSync(appData, { recursive: true });
    writeFileSync(paths().settings, '{\n  "env": {}\n}\n');
    writeFileSync(paths().mcpConfig, '{}\n');
    writeFileSync(
      join(root, 'skills', 'review', 'SKILL.md'),
      '---\nname: review\ndescription: Code review\n---\n\n# Review\n',
    );
    writeFileSync(
      join(appData, 'state.json'),
      JSON.stringify({
        groups: [],
        automations: [],
        disabled: { rule: [], hook: [], skill: [], mcp: [], permission: [] },
      }),
    );
    store = new AppStore(appData);
    const port = await freePort();
    store.updateSettings({
      dlp: { ...store.getSettings().dlp, port, upstreamUrl: 'http://127.0.0.1:9' },
    });
    proxy = new DlpProxy();
    pending = new PanelPendingActions(10_000);
    const ctx = {
      store,
      location: { paths: paths() },
      backupDir: join(appData, 'backups'),
      pricing: { current: () => ({ entries: [] }) },
      models: { current: () => ({ models: [] }) },
      effectiveSettings: () => store.getSettings(),
    } as unknown as ServerContext;
    const access = {
      allowedOrigins: allowedOrigins(8888),
      requiresToken: () => false,
      expectedToken: () => '',
    };
    app = Fastify();
    registerAccessGate(app, access);
    registerEmptyBodyGuard(app);
    registerConfigRoutes(app, ctx);
    registerEntityRoutes(app, ctx);
    registerGroupRoutes(app, ctx);
    registerEndpointRoutes(app, ctx);
    registerDlpRoutes(app, ctx, proxy);
    registerIntegrationsRoutes(app, ctx, 'http://127.0.0.1:5242');
    registerPanelAgentRoutes(app, ctx, { hub: createEventHub(), pending, access });
    await app.ready();
  });

  afterEach(async () => {
    pending.cancelAll();
    await proxy.stop();
    await app.close();
    rmSync(base, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });

  const call = (name: string, input: unknown) =>
    app.inject({
      method: 'POST',
      url: `/api/agent/actions/${name}`,
      headers: { [PANEL_AGENT_HEADER]: '1' },
      payload: { input, conversationId: 'conv-app' },
    });

  const listPending = async (): Promise<PanelPendingAction[]> =>
    (await app.inject({ method: 'GET', url: '/api/agent/pending' })).json();

  const waitPending = async (): Promise<PanelPendingAction> => {
    for (let attempt = 0; attempt < 300; attempt += 1) {
      const [first] = await listPending();
      if (first) return first;
      await new Promise((done) => setTimeout(done, 10));
    }
    throw new Error('карточка так и не появилась');
  };

  const decided = async (
    name: string,
    input: unknown,
    beforeDecision?: () => void,
  ): Promise<{ card: PanelPendingAction; result: PanelActionResult }> => {
    const running = call(name, input);
    const card = await waitPending();
    beforeDecision?.();
    const decision = await app.inject({
      method: 'POST',
      url: `/api/agent/pending/${card.id}`,
      headers: { origin: ORIGIN },
      payload: { decision: 'approve' },
    });
    expect(decision.statusCode).toBe(200);
    return { card, result: (await running).json<PanelActionResult>() };
  };

  it('группы: создать с env, выключить (env ушёл из settings.json), удалить', async () => {
    const created = await decided('save_group', {
      name: 'Ревью',
      members: ['skill:review'],
      env: { REVIEW_MODE: 'strict' },
    });
    expect(created.card.preview.diff).toContain('REVIEW_MODE');
    expect(created.result.outcome).toBe('done');
    const group = disk()
      .getGroups()
      .find((item) => item.name === 'Ревью');
    expect(group?.members).toEqual([{ kind: 'skill', id: 'review' }]);
    expect(settingsJson().env?.REVIEW_MODE).toBe('strict');

    const listed = (await call('list_groups', {})).json<PanelActionResult>();
    expect(JSON.stringify(listed.result)).toContain('skill:review');

    const off = await decided('toggle_group', { id: group!.id, isEnabled: false });
    expect(off.result.outcome).toBe('done');
    expect(settingsJson().env?.REVIEW_MODE).toBeUndefined();
    expect(
      disk()
        .getGroups()
        .find((item) => item.id === group!.id)?.isEnabled,
    ).toBe(false);

    const removed = await decided('delete_group', { id: group!.id });
    expect(removed.card.risk).toBe('danger');
    expect(removed.result.outcome).toBe('done');
    expect(disk().getGroups()).toEqual([]);
  });

  it('save_group с секретом в env — отказ без карточки', async () => {
    const result = (
      await call('save_group', {
        name: 'Утечка',
        env: { GH: 'ghp_abcdefghijklmnopqrstuvwxyz0123456789' },
      })
    ).json<PanelActionResult>();
    expect(result.outcome).toBe('failed');
    expect(await listPending()).toEqual([]);
    expect(disk().getGroups()).toEqual([]);
  });

  it('настройки: читаемые ключи правятся, человеческие — отклоняются входом', async () => {
    const read = (await call('get_settings', {})).json<PanelActionResult>();
    expect(read.outcome).toBe('done');

    const { card, result } = await decided('update_settings', { theme: 'dark', backupKeep: 7 });
    expect(card.preview.diff).toContain('dark');
    expect(result.outcome).toBe('done');
    expect(disk().getSettings()).toMatchObject({ theme: 'dark', backupKeep: 7 });

    const human = (
      await call('update_settings', { revealSecretsByDefault: true })
    ).json<PanelActionResult>();
    expect(human.outcome).toBe('invalid');
    expect(await listPending()).toEqual([]);
  });

  it('switch_provider: неизвестный — отказ; известный — после «да» активен', async () => {
    const unknown = (await call('switch_provider', { provider: 'nope' })).json<PanelActionResult>();
    expect(unknown.outcome).toBe('failed');
    expect(unknown.message).toContain('codex');

    const { card, result } = await decided('switch_provider', { provider: 'codex' });
    expect(card.risk).toBe('danger');
    expect(result.outcome).toBe('done');
    expect(disk().getSettings().provider).toBe('codex');
  });

  it('эндпоинт: создать (поле токена человеку по тому же id), применить к claude, удалить', async () => {
    const input = {
      name: 'Локальный',
      baseUrl: 'http://127.0.0.1:11434/v1',
      apiKind: 'anthropic',
      model: 'claude-local',
    };
    const { card, result } = await decided('save_endpoint', input);
    const saved = disk().getSettings().endpointProfiles;
    expect(saved).toHaveLength(1);
    const id = saved[0]!.id;
    expect(id).toMatch(/^ep-[0-9a-f]{12}$/);
    expect(card.preview.diff).toContain(id);
    expect(result).toMatchObject({
      outcome: 'needs-secret',
      page: { route: '/settings', focus: `endpoint-token:${id}` },
    });

    const list = (await call('list_endpoints', {})).json<PanelActionResult>();
    expect(list.result).toMatchObject({ profiles: [{ id, hasToken: false }] });

    const applied = await decided('apply_endpoint', { id, provider: 'claude' });
    expect(applied.result.outcome).toBe('done');
    expect(JSON.stringify(settingsJson().env)).toContain('127.0.0.1:11434');

    // Проба ходит по адресу профиля: заглушка вместо чужого сервера — граница сети.
    const hits: string[] = [];
    const upstream = createHttpServer((request, response) => {
      hits.push(request.url ?? '');
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({ data: [{ id: 'claude-local', type: 'model' }] }));
    });
    await new Promise<void>((done) => upstream.listen(0, '127.0.0.1', done));
    const port = (upstream.address() as { port: number }).port;
    try {
      const moved = await decided('save_endpoint', {
        ...input,
        id,
        baseUrl: `http://127.0.0.1:${port}`,
      });
      expect(moved.result.outcome).toBe('done');
      const probe = (await call('probe_endpoint', { id })).json<PanelActionResult>();
      expect(probe.outcome).toBe('done');
      expect(hits.length).toBeGreaterThan(0);
      expect(JSON.stringify(probe.result)).toContain('claude-local');
    } finally {
      await new Promise((done) => upstream.close(done));
    }

    const removed = await decided('delete_endpoint', { id });
    expect(removed.result.outcome).toBe('done');
    expect(disk().getSettings().endpointProfiles).toEqual([]);
  });

  /**
   * Вызов, у которого карточки быть НЕ должно: пока ответа нет, список ожидающих
   * опрашивается; появившаяся карточка отклоняется (иначе вызов висел бы до
   * таймаута) и возвращается как улика.
   */
  const callWithoutCard = async (name: string, input: unknown) => {
    let settled = false;
    const running = call(name, input).then((res) => {
      settled = true;
      return res.json<PanelActionResult>();
    });
    const cards: PanelPendingAction[] = [];
    while (!settled) {
      for (const card of await listPending()) {
        cards.push(card);
        await app.inject({
          method: 'POST',
          url: `/api/agent/pending/${card.id}`,
          headers: { origin: ORIGIN },
          payload: { decision: 'reject' },
        });
      }
      await new Promise((done) => setTimeout(done, 10));
    }
    return { cards, result: await running };
  };

  it('apply_endpoint: неподдержанный CLI — отказ с причиной ДО карточки, файл не тронут', async () => {
    const { result: saved } = await decided('save_endpoint', {
      name: 'Совместимый',
      baseUrl: 'http://127.0.0.1:11434/v1',
      apiKind: 'openai-compat',
      model: 'qwen',
    });
    expect(saved.outcome).not.toBe('failed');
    const id = disk().getSettings().endpointProfiles[0]!.id;
    const before = readFileSync(paths().settings, 'utf8');

    for (const [provider, reason] of [
      ['claude', 'api_kind_mismatch'],
      ['codex', 'no_documented_base_url'],
      ['nope', 'Unknown provider'],
    ] as const) {
      const { cards, result } = await callWithoutCard('apply_endpoint', { id, provider });
      expect(cards, provider).toEqual([]);
      expect(result.outcome, provider).toBe('failed');
      expect(result.message, provider).toContain(reason);
    }
    expect(readFileSync(paths().settings, 'utf8')).toBe(before);

    // Поддержанный остаётся с карточкой, и карточка называет файл и переменные.
    // Решение — «нет»: файл aider лежит в доме, а тест чужой дом не пишет.
    const running = call('apply_endpoint', { id, provider: 'aider' });
    const card = await waitPending();
    expect(card.preview.fields.map((field) => field.value).join(' ')).toContain(
      'AIDER_OPENAI_API_BASE',
    );
    await app.inject({
      method: 'POST',
      url: `/api/agent/pending/${card.id}`,
      headers: { origin: ORIGIN },
      payload: { decision: 'reject' },
    });
    expect((await running).json<PanelActionResult>().outcome).toBe('rejected');
  });

  it('DLP: правила в файл, прокси реально слушает порт и останавливается', async () => {
    const rules = [{ id: 'name', name: 'Имя', kind: 'terms', terms: ['Урманов'] }];
    const saved = await decided('save_dlp_rules', { rules });
    expect(saved.result.outcome).toBe('done');
    const read = (await call('get_dlp', {})).json<PanelActionResult>();
    expect(read.result).toMatchObject({ rules: [{ id: 'name', terms: ['Урманов'] }] });

    const started = await decided('toggle_dlp_proxy', { running: true });
    expect(started.result.outcome).toBe('done');
    expect(proxy.running).toBe(true);
    expect(disk().getSettings().dlp.enabled).toBe(true);

    const stopped = await decided('toggle_dlp_proxy', { running: false });
    expect(stopped.result.outcome).toBe('done');
    expect(proxy.running).toBe(false);
    expect(disk().getSettings().dlp.enabled).toBe(false);
  });

  it('интеграции: адрес без токена — поле токена человеку; секрет в поле — отказ; забыть', async () => {
    const list = (await call('list_integrations', {})).json<PanelActionResult>();
    expect((list.result as unknown[]).length).toBe(6);

    const leak = (
      await call('save_integration', {
        id: 'forge',
        settings: { baseUrl: 'https://gitlab.example.com', token: 'glpat-abcdefghijklmnopqrst' },
      })
    ).json<PanelActionResult>();
    expect(leak.outcome).toBe('failed');
    expect(await listPending()).toEqual([]);

    const { result } = await decided('save_integration', {
      id: 'forge',
      settings: { baseUrl: 'https://gitlab.example.com', enabled: true },
    });
    expect(result).toMatchObject({
      outcome: 'needs-secret',
      page: { route: '/settings', focus: 'integration-secret:forge' },
    });
    expect(
      (disk().getSettings().integrations.forge as unknown as { baseUrl: string }).baseUrl,
    ).toBe('https://gitlab.example.com');

    const check = (await call('check_integration', { id: 'forge' })).json<PanelActionResult>();
    expect(['done', 'failed']).toContain(check.outcome);

    expect(disk().getSettings().integrations.forge.enabled).toBe(true);
    const forgot = await decided('forget_integration', { id: 'forge' });
    expect(forgot.result.outcome).toBe('done');
    expect(disk().getSettings().integrations.forge.enabled).toBe(false);
  });
});
