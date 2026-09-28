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
import { SECRET_MASK } from '../../lib/secret-mask.ts';
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
    // [P3] Живой прогон 26.09: /dlp открывался без подсветки добавленного правила.
    // Список уходит целиком — какое правило новое, знает только маршрут записи.
    expect(saved.result.page).toEqual({ route: '/dlp', focus: 'dlp-rule:name' });
    const added = await decided('save_dlp_rules', {
      rules: [...rules, { id: 'mail', name: 'Почта', kind: 'terms', terms: ['a@b.c'] }],
    });
    expect(added.result.page).toEqual({ route: '/dlp', focus: 'dlp-rule:mail' });
    // Только удаление — подсвечивать нечего, страница открывается без якоря.
    const trimmed = await decided('save_dlp_rules', { rules });
    expect(trimmed.result.page).toEqual({ route: '/dlp' });

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

    // Проверка пишет итог на диск — только после карточки; без токена сеть не нужна.
    const { result: check } = await decided('check_integration', { id: 'forge' });
    expect(check.outcome).toBe('done');

    expect(disk().getSettings().integrations.forge.enabled).toBe(true);
    const forgot = await decided('forget_integration', { id: 'forge' });
    expect(forgot.result.outcome).toBe('done');
    expect(disk().getSettings().integrations.forge.enabled).toBe(false);
  });

  /** Ключ из кусков: литерал целиком похож на настоящий, и сторож его не пропустит. */
  const opaque = () => ['Zx9kLm2Qp', '7Rt4Wv8Yb3Nc6'].join('');

  /** Запись человеком — маршрутом окна, с разрешённым Origin. */
  const human = (method: 'POST' | 'PUT', url: string, payload: object) =>
    app.inject({ method, url, headers: { origin: ORIGIN }, payload });

  // Ревью 26.09: токен профиля лежит по его id и едет за адресом — агент менял
  // хост, а probe_endpoint (чтение, без карточки) отправлял токен на новый.
  it('save_endpoint: хост профиля с сохранённым токеном агент не меняет; путь того же хоста — можно', async () => {
    const input = {
      name: 'Шлюз',
      baseUrl: 'https://gw.example.com/v1',
      apiKind: 'openai-compat',
      model: 'm',
    };
    await decided('save_endpoint', input);
    const id = disk().getSettings().endpointProfiles[0]!.id;
    const token = await human('PUT', `/api/endpoints/${id}/token`, { token: 'sk-test-0123456789' });
    expect(token.statusCode).toBeLessThan(400);

    const { cards, result } = await callWithoutCard('save_endpoint', {
      ...input,
      id,
      baseUrl: 'https://evil.example/v1',
    });
    expect(cards).toEqual([]);
    expect(result).toMatchObject({ outcome: 'failed' });
    expect(result.message).toMatch(/token/i);
    expect(disk().getSettings().endpointProfiles[0]!.baseUrl).toBe('https://gw.example.com/v1');

    const samePlace = await decided('save_endpoint', {
      ...input,
      id,
      baseUrl: 'https://gw.example.com/v2',
    });
    expect(samePlace.result.outcome).toBe('done');
  });

  it('save_endpoint: второй профиль с тем же именем, адресом и видом API — отказ до карточки', async () => {
    const input = {
      name: 'Дубль',
      baseUrl: 'http://127.0.0.1:11434/v1',
      apiKind: 'anthropic',
      model: 'first',
    };
    expect((await decided('save_endpoint', input)).result.outcome).not.toBe('failed');
    const id = disk().getSettings().endpointProfiles[0]!.id;

    const { cards, result } = await callWithoutCard('save_endpoint', { ...input, model: 'second' });
    expect(cards).toEqual([]);
    expect(result.outcome).toBe('failed');
    expect(result.message).toContain(id);
    expect(
      disk()
        .getSettings()
        .endpointProfiles.map((item) => item.model),
    ).toEqual(['first']);
  });

  it('save_integration: адрес, прочитанный маской, пишется значением с диска; лишняя маска — отказ', async () => {
    const url = `https://hooks.example.com/in?token=${opaque()}`;
    const seeded = await human('PUT', '/api/integrations/webhook', {
      settings: { enabled: false, url, events: ['runError'] },
    });
    expect(seeded.statusCode).toBe(200);
    const listed = (await call('list_integrations', {})).json<PanelActionResult>();
    const shown = (listed.result as { id: string; settings: { url: string } }[]).find(
      (item) => item.id === 'webhook',
    )!.settings.url;
    expect(shown).not.toContain(opaque());
    expect(shown).toContain(SECRET_MASK);

    const webhook = () =>
      disk().getSettings().integrations.webhook as unknown as { url: string; enabled: boolean };
    const { result } = await decided('save_integration', {
      id: 'webhook',
      settings: { url: shown, enabled: true },
    });
    expect(result.outcome).not.toBe('failed');
    expect(webhook()).toMatchObject({ url, enabled: true });

    const extra = await callWithoutCard('save_integration', {
      id: 'webhook',
      settings: { url: `${shown}&sig=${SECRET_MASK}` },
    });
    expect(extra.cards).toEqual([]);
    expect(extra.result.outcome).toBe('failed');
    // Маска внутри списка или объекта — тоже отказ до карточки, не 400 после «да».
    const nested = await callWithoutCard('save_integration', {
      id: 'webhook',
      settings: { events: [SECRET_MASK] },
    });
    expect(nested.cards).toEqual([]);
    expect(nested.result.outcome).toBe('failed');
    expect(webhook().url).toBe(url);
  });

  // Ревью 28.09 (F-08): профиль эндпоинта и MCP с секретами отказывают при смене
  // хоста, интеграция — нет: одна карточка «Адрес» отправляла сохранённый токен
  // туда, куда указала модель.
  it('save_integration: при сохранённом токене смена хоста — отказ до карточки', async () => {
    const seeded = await human('PUT', '/api/integrations/forge', {
      settings: { enabled: true, kind: 'gitlab', baseUrl: 'https://gitlab.example.com', repo: '' },
      token: 'glpat-abcdefghijklmnopqrst',
    });
    expect(seeded.statusCode).toBe(200);
    const forge = () =>
      disk().getSettings().integrations.forge as unknown as { baseUrl: string; kind: string };

    for (const settings of [
      { baseUrl: 'https://evil.example.net' },
      { baseUrl: '' },
      { kind: 'github' },
    ]) {
      const moved = await callWithoutCard('save_integration', { id: 'forge', settings });
      expect(moved.cards).toEqual([]);
      expect(moved.result.outcome).toBe('failed');
    }
    expect(forge()).toMatchObject({ baseUrl: 'https://gitlab.example.com', kind: 'gitlab' });

    // Тот же хост, другой путь и остальные поля — проходят.
    const { result } = await decided('save_integration', {
      id: 'forge',
      settings: { baseUrl: 'https://gitlab.example.com/', repo: 'team/app' },
    });
    expect(result.outcome).not.toBe('failed');
    expect(forge().baseUrl).toBe('https://gitlab.example.com/');
  });

  it('save_group: env, прочитанный маской (list_env), пишется значением с диска; маска в новой группе — отказ', async () => {
    const dbUrl = `postgres://app:${opaque()}@db:5432/x`;
    const made = await human('POST', '/api/groups', { name: 'База', env: { DB_URL: dbUrl } });
    expect(made.statusCode).toBe(200);
    const id = made.json<{ id: string }>().id;
    const listed = (await call('list_env', {})).json<PanelActionResult>();
    const shown = (listed.result as { variables: { key: string; value: string }[] }).variables.find(
      (item) => item.key === 'DB_URL',
    )!.value;
    expect(shown).toContain(SECRET_MASK);

    const { result } = await decided('save_group', {
      id,
      name: 'База',
      env: { DB_URL: shown, MODE: 'on' },
    });
    expect(result.outcome).toBe('done');
    expect(disk().getGroups()[0]?.env).toEqual({ DB_URL: dbUrl, MODE: 'on' });
    expect(settingsJson().env?.DB_URL).toBe(dbUrl);

    const fresh = await callWithoutCard('save_group', { name: 'Новая', env: { DB_URL: shown } });
    expect(fresh.cards).toEqual([]);
    expect(fresh.result.outcome).toBe('failed');
    expect(disk().getGroups()).toHaveLength(1);
  });

  it('[P3] save_group: env выключенной группы с секретом правится — list_groups даёт значения маской, маска секрета возвращается с диска', async () => {
    // Выключенная группа: её env не в settings.json, list_env его не видит. Раньше
    // list_groups давал одни имена, а env правки — полная замена: добавить ключ
    // значило стереть остальные. Секретное имя с маской отказывалось как «секрет».
    const token = opaque();
    const made = await human('POST', '/api/groups', {
      name: 'Пробный',
      env: { AGENTDECK_PROBE_P3_G1: 'one', AGENTDECK_PROBE_P3_API_TOKEN: token },
    });
    const id = made.json<{ id: string }>().id;
    await app.inject({
      method: 'POST',
      url: `/api/groups/${id}/enabled`,
      headers: { origin: ORIGIN },
      payload: { isEnabled: false },
    });
    const listed = (await call('list_groups', {})).json<PanelActionResult>();
    const env = (
      listed.result as { groups: { id: string; env: Record<string, string> }[] }
    ).groups.find((group) => group.id === id)!.env;
    expect(env).toEqual({
      AGENTDECK_PROBE_P3_G1: 'one',
      AGENTDECK_PROBE_P3_API_TOKEN: SECRET_MASK,
    });
    expect(JSON.stringify(listed.result)).not.toContain(token);

    const { result } = await decided('save_group', {
      id,
      name: 'Пробный',
      env: { ...env, AGENTDECK_PROBE_P3_G4: 'four' },
    });
    expect(result.outcome).toBe('done');
    expect(
      disk()
        .getGroups()
        .find((group) => group.id === id)?.env,
    ).toEqual({
      AGENTDECK_PROBE_P3_G1: 'one',
      AGENTDECK_PROBE_P3_API_TOKEN: token,
      AGENTDECK_PROBE_P3_G4: 'four',
    });
  });

  it('[P3] delete_group: карточка называет, что удаление сделает за пределами state.json', async () => {
    // Живой прогон 26.09: карточка показывала только запись группы в state.json,
    // а удаление снимало её переменные из settings.json и включало обратно
    // участников, которых гасила выключенная группа.
    const on = await decided('save_group', {
      name: 'Вкл',
      members: ['skill:review'],
      env: { AGENTDECK_PROBE_P3_G1: 'one' },
    });
    expect(on.result.outcome).toBe('done');
    const onId = disk().getGroups()[0]!.id;
    const fieldsOf = async (id: string) => {
      const running = call('delete_group', { id });
      const card = await waitPending();
      await app.inject({
        method: 'POST',
        url: `/api/agent/pending/${card.id}`,
        headers: { origin: ORIGIN },
        payload: { decision: 'reject' },
      });
      await running;
      return Object.fromEntries((card.preview.fields ?? []).map((f) => [f.labelCode, f.value]));
    };
    const onFields = await fieldsOf(onId);
    expect(onFields['label-group-delete-env']).toBe('AGENTDECK_PROBE_P3_G1');
    expect(onFields['label-group-delete-back-on']).toBeUndefined();
    expect(onFields['label-members']).toBe('skill:review');

    await decided('toggle_group', { id: onId, isEnabled: false });
    const offFields = await fieldsOf(onId);
    expect(offFields['label-group-delete-env']).toBeUndefined();
    expect(offFields['label-group-delete-back-on']).toBe('skill:review');

    // Карточка не соврала: после удаления участник включён, переменной нет.
    // И итог действия говорит это модели: иначе её ответ после удаления
    // преуменьшал сделанное («группа удалена» — и только).
    const removed = await decided('delete_group', { id: onId });
    expect(removed.result.result).toMatchObject({
      ok: true,
      envRemoved: [],
      membersBackOn: ['skill:review'],
    });
    expect(disk().isDisabled('skill', 'review')).toBe(false);
    expect(settingsJson().env?.AGENTDECK_PROBE_P3_G1).toBeUndefined();
  });

  it('save_group: новая группа открывается на странице групп с фокусом на ней', async () => {
    const { result } = await decided('save_group', { name: 'Фокус' });
    const id = disk().getGroups()[0]!.id;
    expect(result.page).toEqual({ route: '/groups', focus: id });
  });

  it('настройки открываются на вкладке своего раздела: модели, интеграции, провайдеры, ключ', async () => {
    const input = {
      name: 'Вкладка',
      baseUrl: 'http://127.0.0.1:11434/v1',
      apiKind: 'anthropic',
      model: 'one',
    };
    await decided('save_endpoint', input);
    const id = disk().getSettings().endpointProfiles[0]!.id;
    const models = { route: `/settings?id=${id}`, focus: 'models' };
    const edited = await decided('save_endpoint', { ...input, id, model: 'two' });
    expect(edited.result).toMatchObject({ outcome: 'done', page: models });
    expect((await decided('apply_endpoint', { id, provider: 'claude' })).result.page).toEqual(
      models,
    );
    expect((await decided('delete_endpoint', { id })).result.page).toEqual({
      route: '/settings',
      focus: 'models',
    });

    const seeded = await human('PUT', '/api/integrations/forge', {
      settings: { enabled: false, kind: 'gitlab', baseUrl: 'https://gitlab.example.com', repo: '' },
      token: opaque(),
    });
    expect(seeded.statusCode).toBe(200);
    // Действие ведёт на СВОЮ карточку, а не в начало вкладки (живой прогон 26.09:
    // карточка вебхука — шестая, под экраном).
    const integrations = { route: '/settings', focus: 'integration:forge' };
    const saved = await decided('save_integration', {
      id: 'forge',
      settings: { repo: 'team/app' },
    });
    expect(saved.result).toMatchObject({ outcome: 'done', page: integrations });
    expect((await decided('forget_integration', { id: 'forge' })).result.page).toEqual(
      integrations,
    );

    for (const [patch, tab] of [
      [{ chatEffort: 'high' }, 'models'],
      [{ backupKeep: 9 }, 'safety'],
      [{ costUnit: 'money' }, 'spend'],
      [{ theme: 'dark' }, 'general'],
    ] as const) {
      const { result } = await decided('update_settings', patch);
      expect(result.page, tab).toEqual({ route: '/settings', focus: tab });
    }

    const switched = await decided('switch_provider', { provider: 'codex' });
    expect(switched.result.page).toEqual({ route: '/settings', focus: 'providers' });
  });

  it('check_integration: проверка шлёт наружу и пишет итог — только после карточки', async () => {
    const hits: string[] = [];
    // Приёмник вебхука — граница сети: настоящая отправка уходит в него.
    const receiver = createHttpServer((request, response) => {
      hits.push(request.method ?? '');
      response.end('{}');
    });
    await new Promise<void>((done) => receiver.listen(0, '127.0.0.1', done));
    const url = `http://127.0.0.1:${(receiver.address() as { port: number }).port}/hook`;
    try {
      const seeded = await human('PUT', '/api/integrations/webhook', {
        settings: { enabled: true, url, events: ['runError'] },
      });
      expect(seeded.statusCode).toBe(200);

      const running = call('check_integration', { id: 'webhook' });
      const card = await waitPending();
      expect(card.risk).toBe('change');
      expect(card.preview.fields.map((field) => field.value).join(' ')).toContain(url);
      expect(hits).toEqual([]);
      await app.inject({
        method: 'POST',
        url: `/api/agent/pending/${card.id}`,
        headers: { origin: ORIGIN },
        payload: { decision: 'reject' },
      });
      expect((await running).json<PanelActionResult>().outcome).toBe('rejected');
      expect(hits).toEqual([]);

      const { result } = await decided('check_integration', { id: 'webhook' });
      expect(result.outcome).toBe('done');
      expect(hits).toEqual(['POST']);
    } finally {
      await new Promise((done) => receiver.close(done));
    }
  });

  it('check_integration: без адреса — отказ до карточки, одобрять нечего', async () => {
    // Живой прогон 26.09: «проверь связь вебхука» при пустом адресе давал карточку,
    // человек одобрял, и проверка падала «не указан адрес» — одобрение впустую.
    const seeded = await human('PUT', '/api/integrations/webhook', {
      settings: { enabled: false, url: '', events: ['runError'] },
    });
    expect(seeded.statusCode).toBe(200);
    const answer = (await call('check_integration', { id: 'webhook' })).json<PanelActionResult>();
    expect(answer.outcome).toBe('failed');
    expect(answer.message).toContain('save_integration');
    expect(await listPending()).toEqual([]);
  });

  it('toggle_dlp_proxy: в настройках включено, а прокси лежит — «запустить» поднимает его', async () => {
    // Без включённого правила прокси не поднимается вовсе — правило ставит человек.
    const rules = await human('PUT', '/api/dlp/rules', {
      rules: [{ id: 'name', name: 'Имя', kind: 'terms', terms: ['Урманов'] }],
    });
    expect(rules.statusCode).toBe(200);
    store.updateSettings({ dlp: { ...store.getSettings().dlp, enabled: true } });
    expect(proxy.running).toBe(false);
    const { card, result } = await decided('toggle_dlp_proxy', { running: true });
    expect(card.preview.diff).toContain('running');
    expect(result.outcome).toBe('done');
    expect(proxy.running).toBe(true);
  });

  it('toggle_dlp_proxy: прокси подняли между карточкой и «да» — карточка устарела', async () => {
    const rules = await human('PUT', '/api/dlp/rules', {
      rules: [{ id: 'name', name: 'Имя', kind: 'terms', terms: ['Урманов'] }],
    });
    expect(rules.statusCode).toBe(200);
    store.updateSettings({ dlp: { ...store.getSettings().dlp, enabled: true } });
    const running = call('toggle_dlp_proxy', { running: true });
    const card = await waitPending();
    // Флаг в настройках уже `true` и не меняется: разницу видит только слушатель.
    expect((await human('POST', '/api/dlp/start', {})).statusCode).toBe(200);
    await app.inject({
      method: 'POST',
      url: `/api/agent/pending/${card.id}`,
      headers: { origin: ORIGIN },
      payload: { decision: 'approve' },
    });
    expect((await running).json<PanelActionResult>()).toMatchObject({
      outcome: 'failed',
      messageCode: 'stale_preview',
    });
  });

  it('save_integration: вебхуку ключ не нужен, выключение ключа не просит; адрес — строкой карточки', async () => {
    const hook = await decided('save_integration', {
      id: 'webhook',
      settings: { url: 'http://127.0.0.1:9/agentdeck-hook', enabled: true },
    });
    // Секрет подписи вебхука необязателен (TOKENLESS): «нужен ключ» тут неправда.
    expect(hook.result.outcome).toBe('done');
    expect(hook.card.preview.fields).toContainEqual(
      expect.objectContaining({
        labelCode: 'label-address',
        value: 'http://127.0.0.1:9/agentdeck-hook',
      }),
    );

    const integrations = store.getSettings().integrations;
    store.updateSettings({
      integrations: { ...integrations, forge: { ...integrations.forge, enabled: true } },
    });
    const off = await decided('save_integration', { id: 'forge', settings: { enabled: false } });
    expect(off.result.outcome).toBe('done');
    expect(off.result.page).toEqual({ route: '/settings', focus: 'integration:forge' });
  });

  it('toggle_dlp_proxy: без адреса пересылки или без правил — отказ до карточки; адрес — строкой карточки', async () => {
    const noRules = await callWithoutCard('toggle_dlp_proxy', { running: true });
    expect(noRules.cards).toEqual([]);
    expect(noRules.result.outcome).toBe('failed');
    expect(noRules.result.message).toMatch(/rule/i);

    const rules = await human('PUT', '/api/dlp/rules', {
      rules: [{ id: 'name', name: 'Имя', kind: 'terms', terms: ['Урманов'] }],
    });
    expect(rules.statusCode).toBe(200);
    store.updateSettings({ dlp: { ...store.getSettings().dlp, upstreamUrl: '' } });
    const noUpstream = await callWithoutCard('toggle_dlp_proxy', { running: true });
    expect(noUpstream.cards).toEqual([]);
    expect(noUpstream.result.outcome).toBe('failed');
    expect(noUpstream.result.message).toContain('/dlp');
    expect(proxy.running).toBe(false);

    // Адрес из профиля эндпоинта — тот же выбор, что у запуска (`resolveDlpUpstream`).
    store.updateSettings({
      endpointProfiles: [
        {
          id: 'ep-up',
          name: 'Шлюз',
          baseUrl: 'http://127.0.0.1:9/gw',
          apiKind: 'anthropic',
          model: '',
          writeToken: false,
        } as never,
      ],
      dlp: { ...store.getSettings().dlp, upstreamProfileId: 'ep-up' },
    });
    const { card } = await decided('toggle_dlp_proxy', { running: true });
    expect(card.preview.fields).toContainEqual(
      expect.objectContaining({ labelCode: 'label-address', value: 'http://127.0.0.1:9/gw' }),
    );
  });
});
