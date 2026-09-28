import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import { homedir, tmpdir } from 'node:os';
import type { PanelActionResult, PanelPendingAction } from '@agentdeck/contracts/panel-agent';
import { PANEL_AGENT_HEADER } from '@agentdeck/contracts/panel-agent';
import { AppStore } from '../../lib/app-store.ts';
import type { ServerContext } from '../../context.ts';
import { registerAccessGate } from '../../lib/access-gate.ts';
import { registerEmptyBodyGuard } from '../../lib/empty-body.ts';
import { createEventHub } from '../../lib/event-hub.ts';
import { allowedOrigins } from '../../lib/origin-guard.ts';
import { resetCliLookupCache } from '../../providers/detect.ts';
import { forgetInstalledPlugins } from '../../domains/plugins/read.ts';
import { PanelPendingActions } from '../../domains/panel-agent/pending.ts';
import { registerConfigRoutes } from '../config-routes.ts';
import { registerEntityRoutes } from '../entity-routes.ts';
import { registerSearchRoutes } from '../search-routes.ts';
import { registerPluginRoutes } from '../plugin-routes.ts';
import { registerHistoryRoutes } from '../history-routes.ts';
import { registerBackupRoutes } from '../backup-routes.ts';
import { registerAnalyticsRoutes } from '../analytics-routes.ts';
import { registerProviderCompareRoutes } from '../provider-compare-routes.ts';
import { registerPortabilityRoutes } from '../portability-routes.ts';
import { registerProjectRoutes } from '../project-routes.ts';
import { DEFAULT_HELP_WEB_SRC } from './help-routes.ts';
import { registerPanelAgentRoutes } from './panel-agent-routes.ts';

/**
 * Справка, обзор, поиск, плагины, история и копии — на настоящих маршрутах.
 * Справка читается из НАСТОЯЩИХ исходников веба (та же, что у человека);
 * плагины исполняет ФАЛЬШИВЫЙ `claude` на PATH со своим состоянием в файле;
 * история и копии — временный каталог конфигурации.
 */
const isWindows = process.platform === 'win32';
const ORIGIN = 'http://localhost:8888';

/** Фальшивый CLI: `plugin list --json | install | uninstall | enable | disable`. */
const FAKE = `
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
const state = process.env.CC_FAKE_PLUGINS;
const read = () => (existsSync(state) ? JSON.parse(readFileSync(state, 'utf8')) : []);
const [group, verb, id, extra] = process.argv.slice(2);
if (group !== 'plugin') { process.stderr.write('unknown'); process.exit(2); }
const list = read();
if (verb === 'list' && id === '--available') {
  const extra = Array.from({ length: Number(process.env.CC_FAKE_EXTRA || 0) }, (_, index) => ({ id: 'extra' + index + '@team' }));
  process.stdout.write(JSON.stringify({ installed: list, available: [{ id: 'fmt@team', description: 'Formatter', installCount: 5 }, { id: 'lint@team' }, ...extra] }));
  process.exit(0);
}
if (verb === 'list') { process.stdout.write(JSON.stringify(list)); process.exit(0); }
if (verb === 'marketplace') {
  const file = process.env.CC_FAKE_ROOT + '/plugins/known_marketplaces.json';
  const known = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : {};
  if (id === 'add') known[extra.split('/').pop()] = { source: { source: 'github', repo: extra } };
  else delete known[extra];
  mkdirSync(process.env.CC_FAKE_ROOT + '/plugins', { recursive: true });
  writeFileSync(file, JSON.stringify(known));
  process.stdout.write('ok');
  process.exit(0);
}
if (verb === 'install') {
  if (id.startsWith('broken')) { process.stderr.write('Plugin "' + id + '" not found in any marketplace'); process.exit(1); }
  list.push({ id, version: '1.0.0', scope: 'user', enabled: true });
} else if (verb === 'uninstall') {
  writeFileSync(state, JSON.stringify(list.filter((item) => item.id !== id))); process.stdout.write('ok'); process.exit(0);
} else if (verb === 'update') {
  for (const item of list) if (item.id === id) item.version = '9.9.9';
} else if (verb === 'enable' || verb === 'disable') {
  for (const item of list) if (item.id === id) item.enabled = verb === 'enable';
}
writeFileSync(state, JSON.stringify(list));
process.stdout.write('ok');
`;

describe('panel-agent actions: help, overview, plugins, history', () => {
  let base: string;
  let root: string;
  let appData: string;
  let bin: string;
  let pluginsFile: string;
  let pending: PanelPendingActions;
  let app: FastifyInstance;
  const savedPath = process.env.PATH;
  const savedPlugins = process.env.CC_FAKE_PLUGINS;

  const paths = () => ({
    root,
    appData,
    settings: join(root, 'settings.json'),
    settingsLocal: join(root, 'settings.local.json'),
    claudeMd: join(root, 'CLAUDE.md'),
    secretsEnv: join(root, '.mcp-secrets.env'),
    skills: join(root, 'skills'),
    hooks: join(root, 'hooks'),
    projects: join(root, 'projects'),
    mcpConfig: join(base, '.claude.json'),
  });

  beforeEach(async () => {
    base = mkdtempSync(join(tmpdir(), 'cc-agent-panel-'));
    root = join(base, '.claude');
    appData = join(root, 'agentdeck');
    mkdirSync(appData, { recursive: true });
    mkdirSync(paths().projects, { recursive: true });
    writeFileSync(paths().settings, '{\n  "env": { "REVIEW_DEPTH": "3" }\n}\n');
    writeFileSync(paths().claudeMd, '# Правила\n\nПервая строка.\nВторая строка.\n');
    writeFileSync(paths().mcpConfig, '{}\n');

    bin = mkdtempSync(join(tmpdir(), 'cc-agent-panel-bin-'));
    pluginsFile = join(bin, 'plugins.json');
    const script = join(bin, 'fake-claude.mjs');
    writeFileSync(script, FAKE, 'utf8');
    if (isWindows) {
      writeFileSync(
        join(bin, 'claude.cmd'),
        `@echo off\r\n"${process.execPath}" "${script}" %*\r\n`,
      );
      const system32 = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32');
      process.env.PATH = `${bin}${delimiter}${system32}`;
    } else {
      writeFileSync(
        join(bin, 'claude'),
        `#!/bin/sh\nexec "${process.execPath}" "${script}" "$@"\n`,
        {
          mode: 0o755,
        },
      );
      process.env.PATH = `${bin}${delimiter}/usr/bin${delimiter}/bin`;
    }
    process.env.CC_FAKE_PLUGINS = pluginsFile;
    process.env.CC_FAKE_ROOT = root;
    writeFileSync(
      pluginsFile,
      JSON.stringify([{ id: 'lint@team', version: '2.1.0', enabled: true }]),
    );
    resetCliLookupCache();
    forgetInstalledPlugins();

    const store = new AppStore(appData);
    mkdirSync(join(base, 'proj'), { recursive: true });
    store.addProject({ id: 'p-panel', name: 'proj', path: join(base, 'proj') });
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
    registerSearchRoutes(app, ctx);
    registerPluginRoutes(app, ctx);
    registerHistoryRoutes(app, ctx);
    registerBackupRoutes(app, ctx);
    registerAnalyticsRoutes(app, ctx);
    registerProviderCompareRoutes(app, ctx);
    registerPortabilityRoutes(app, ctx);
    registerProjectRoutes(app, ctx);
    registerPanelAgentRoutes(app, ctx, { hub: createEventHub(), pending, access });
    await app.ready();
  });

  afterEach(async () => {
    pending.cancelAll();
    await app.close();
    process.env.PATH = savedPath;
    delete process.env.CC_FAKE_ROOT;
    delete process.env.CC_FAKE_EXTRA;
    if (savedPlugins === undefined) delete process.env.CC_FAKE_PLUGINS;
    else process.env.CC_FAKE_PLUGINS = savedPlugins;
    resetCliLookupCache();
    forgetInstalledPlugins();
    for (const dir of [base, bin]) {
      rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  });

  const call = (name: string, input: unknown) =>
    app.inject({
      method: 'POST',
      url: `/api/agent/actions/${name}`,
      headers: { [PANEL_AGENT_HEADER]: '1' },
      payload: { input, conversationId: 'conv-panel' },
    });

  const listPending = async (): Promise<PanelPendingAction[]> =>
    (await app.inject({ method: 'GET', url: '/api/agent/pending' })).json();

  const waitPending = async (): Promise<PanelPendingAction> => {
    for (let attempt = 0; attempt < 500; attempt += 1) {
      const [first] = await listPending();
      if (first) return first;
      await new Promise((done) => setTimeout(done, 10));
    }
    throw new Error('карточка так и не появилась');
  };

  const decided = async (
    name: string,
    input: unknown,
  ): Promise<{ card: PanelPendingAction; result: PanelActionResult }> => {
    const running = call(name, input);
    const card = await waitPending();
    const decision = await app.inject({
      method: 'POST',
      url: `/api/agent/pending/${card.id}`,
      headers: { origin: ORIGIN },
      payload: { decision: 'approve' },
    });
    expect(decision.statusCode).toBe(200);
    return { card, result: (await running).json<PanelActionResult>() };
  };

  it('справка: каждая тема из каталога текстов есть в индексе и читается на обоих языках', async () => {
    // Власть — модули текстов тем, а не индекс, который проверяем.
    const textModules = readdirSync(
      join(DEFAULT_HELP_WEB_SRC, 'shared', 'config', 'i18n', 'help', 'ru', 'topics'),
    )
      .filter((file) => file.endsWith('.ts'))
      .map((file) => file.slice(0, -3))
      .sort();
    expect(textModules.length).toBeGreaterThanOrEqual(27);

    for (const language of ['ru', 'en'] as const) {
      const list = (await call('list_help_topics', { language })).json<PanelActionResult>();
      expect(list.outcome).toBe('done');
      const topics = (list.result as { topics: Array<{ id: string; title: string }> }).topics;
      expect(topics.map((topic) => topic.id).sort()).toEqual(textModules);
      const problems: string[] = [];
      for (const topic of topics) {
        const read = (
          await call('read_help_topic', { id: topic.id, language, limit: 200 })
        ).json<PanelActionResult>();
        const body = read.result as { title?: string; lines?: unknown[]; totalLines?: number };
        if (read.outcome !== 'done') problems.push(`${language}/${topic.id}: ${read.outcome}`);
        else if (!body.title || topic.title === topic.id)
          problems.push(`${language}/${topic.id}: без заголовка`);
        else if (!body.totalLines || body.totalLines < 3)
          problems.push(`${language}/${topic.id}: строк ${body.totalLines}`);
      }
      expect(problems).toEqual([]);
    }

    const missing = (await call('read_help_topic', { id: 'nowhere' })).json<PanelActionResult>();
    expect(missing.outcome).toBe('failed');
    expect(missing.message).toContain('hooks');
  });

  it('справка: поиск «хук» находит тему хуков, по-английски «hook» — тоже', async () => {
    const ru = (
      await call('search_help', { query: 'хук', language: 'ru' })
    ).json<PanelActionResult>();
    expect(ru.outcome).toBe('done');
    expect(JSON.stringify(ru.result)).toContain('"hooks"');
    const en = (
      await call('search_help', { query: 'hook', language: 'en' })
    ).json<PanelActionResult>();
    expect(JSON.stringify(en.result)).toContain('"hooks"');
    // Ревью 28.09, m7: слово другого языка находит тему, а не «в справке ничего нет».
    const crossed = (
      await call('search_help', { query: 'хуки', language: 'en' })
    ).json<PanelActionResult>();
    expect(crossed.result).toMatchObject({ language: 'ru', searchedFirst: 'en' });
    expect(JSON.stringify(crossed.result)).toContain('"hooks"');
    const nowhere = (
      await call('search_help', { query: 'zzqqxx', language: 'en' })
    ).json<PanelActionResult>();
    expect(nowhere.result).toMatchObject({ language: 'en', total: 0 });
  });

  it('обзор и поиск по конфигурации', async () => {
    const overview = (await call('overview', {})).json<PanelActionResult>();
    expect(overview.outcome).toBe('done');
    const search = (
      await call('search_panel', { query: 'REVIEW_DEPTH' })
    ).json<PanelActionResult>();
    expect(search.outcome).toBe('done');
    expect((search.result as { total: number }).total).toBeGreaterThan(0);
  });

  it('search_panel with projectPath: a registered project is searched, a foreign folder refused', async () => {
    const own = (
      await call('search_panel', { query: 'REVIEW_DEPTH', projectPath: join(base, 'proj') })
    ).json<PanelActionResult>();
    expect(own.outcome).toBe('done');
    const outside = join(base, 'outside');
    mkdirSync(join(outside, '.agent', 'tests'), { recursive: true });
    const foreign = (
      await call('search_panel', { query: 'REVIEW_DEPTH', projectPath: outside })
    ).json<PanelActionResult>();
    expect(foreign.outcome).toBe('failed');
    expect(foreign.message).toContain('not registered');
  });

  it('плагины: список от CLI, выключить, удалить; отказ CLI — честный failed', async () => {
    const list = (await call('list_plugins', {})).json<PanelActionResult>();
    expect(list.result).toMatchObject({ installed: [{ id: 'lint@team', isEnabled: true }] });

    const off = await decided('toggle_plugin', { id: 'lint@team', isEnabled: false });
    expect(off.result.outcome).toBe('done');
    expect(JSON.parse(readFileSync(pluginsFile, 'utf8'))[0].enabled).toBe(false);

    const broken = await decided('install_plugin', { id: 'broken@team' });
    expect(broken.card.risk).toBe('danger');
    expect(broken.result.outcome).toBe('failed');
    expect(broken.result.message).toContain('not found');

    const installed = await decided('install_plugin', { id: 'fmt@team' });
    expect(installed.result.outcome).toBe('done');
    const again = (await call('install_plugin', { id: 'fmt@team' })).json<PanelActionResult>();
    expect(again.outcome).toBe('failed');
    expect(await listPending()).toEqual([]);

    const removed = await decided('uninstall_plugin', { id: 'lint@team' });
    expect(removed.result.outcome).toBe('done');
    expect(
      JSON.parse(readFileSync(pluginsFile, 'utf8')).map((item: { id: string }) => item.id),
    ).toEqual(['fmt@team']);
  });

  it('история: правка человека → дифф → откат ханка; копия → восстановление файла', async () => {
    const original = readFileSync(paths().claudeMd, 'utf8');
    const edited = '# Правила\n\nПервая строка.\nИзменённая строка.\n';
    const put = await app.inject({
      method: 'PUT',
      url: '/api/claude-md',
      payload: { content: edited },
    });
    expect(put.statusCode).toBeLessThan(400);
    expect(readFileSync(paths().claudeMd, 'utf8')).toBe(edited);

    const history = (await call('list_history', {})).json<PanelActionResult>();
    const items = (history.result as { items: Array<{ name: string; canRevert: boolean }> }).items;
    expect(items.length).toBeGreaterThan(0);
    const entry = items[0]!;
    const diff = (await call('history_diff', { name: entry.name })).json<PanelActionResult>();
    const lines = (diff.result as { lines: Array<{ hunk?: number; text: string; kind: string }> })
      .lines;
    const hunk = lines.find((line) => line.hunk !== undefined)?.hunk;
    expect(hunk).toBeDefined();

    const reverted = await decided('revert_history_hunk', { name: entry.name, hunk });
    expect(reverted.card.risk).toBe('danger');
    expect(reverted.result.outcome).toBe('done');
    expect(readFileSync(paths().claudeMd, 'utf8')).toBe(original);

    // Откат сам сделал копию: восстанавливаем файл целиком из самой первой.
    writeFileSync(paths().claudeMd, 'затёрто руками\n');
    const backups = (await call('list_backups', {})).json<PanelActionResult>();
    const copies = (
      backups.result as { items: Array<{ name: string; target: string; createdAt: string }> }
    ).items.filter((item) => item.target.endsWith('CLAUDE.md'));
    expect(copies.length).toBeGreaterThan(0);
    const oldest = [...copies].sort((a, b) => a.createdAt.localeCompare(b.createdAt))[0]!;
    const restored = await decided('restore_backup', { name: oldest.name });
    expect(restored.result.outcome).toBe('done');
    expect(readFileSync(paths().claudeMd, 'utf8')).toBe(original);
  });

  it('история: секрет из правки человека не уходит модели ни в диффе, ни в карточке отката', async () => {
    // Значение собрано из кусков — присваивания, похожего на ключ, в репозитории нет.
    const key = ['Zx9kLmN0pQrS7t', 'UvWxYz12345'].join('');
    const original = readFileSync(paths().claudeMd, 'utf8');
    const put = await app.inject({
      method: 'PUT',
      url: '/api/claude-md',
      payload: { content: `${original}Ключ контура: key=${key}\n` },
    });
    expect(put.statusCode).toBeLessThan(400);

    const [entry] = (
      (await call('list_history', {})).json<PanelActionResult>().result as {
        items: Array<{ name: string }>;
      }
    ).items;
    const diff = (await call('history_diff', { name: entry!.name })).json<PanelActionResult>();
    expect(diff.outcome).toBe('done');
    expect(JSON.stringify(diff.result)).toContain('key=');
    expect(JSON.stringify(diff.result)).not.toContain(key);
    const hunk = (diff.result as { lines: Array<{ hunk?: number }> }).lines.find(
      (line) => line.hunk !== undefined,
    )?.hunk;

    const reverted = await decided('revert_history_hunk', { name: entry!.name, hunk });
    expect(reverted.card.preview.diff).toContain('key=');
    expect(JSON.stringify(reverted.card)).not.toContain(key);
    expect(reverted.result.outcome).toBe('done');
    expect(readFileSync(paths().claudeMd, 'utf8')).toBe(original);
  });

  it('плагины: заведомо несбыточное отказывает до карточки — чужой маркетплейс, кривой источник', async () => {
    // Маркетплейс «tools» подключён — плагин из неподключённого CLI не поставит,
    // а источник с пробелом домен отвергнет уже после «Одобрить».
    mkdirSync(join(root, 'plugins'), { recursive: true });
    writeFileSync(
      join(root, 'plugins', 'known_marketplaces.json'),
      JSON.stringify({ tools: { source: { source: 'github', repo: 'acme/tools' } } }),
    );

    const foreign = (await call('install_plugin', { id: 'fmt@nowhere' })).json<PanelActionResult>();
    expect(foreign.outcome).toBe('failed');
    expect(foreign.message).toContain('nowhere');
    expect(foreign.message).toContain('tools');

    const badId = (
      await call('install_plugin', { id: 'fmt & calc@tools' })
    ).json<PanelActionResult>();
    expect(badId.outcome).toBe('failed');
    // F-290: отказ агенту по-английски, без русского текста для человека.
    expect(badId.message).toContain('not a valid plugin id');
    expect(badId.message).not.toMatch(/[а-яё]/i);

    const badSource = (
      await call('add_plugin_marketplace', { source: 'not a source !!' })
    ).json<PanelActionResult>();
    expect(badSource.outcome).toBe('failed');
    expect(await listPending()).toEqual([]);

    // Годная установка — опасная карточка говорит, ОТКУДА придёт код: адрес маркетплейса.
    const running = call('install_plugin', { id: 'fmt@tools' });
    const card = await waitPending();
    expect(card.preview.fields).toContainEqual(
      expect.objectContaining({ label: 'Адрес', value: 'acme/tools' }),
    );
    await app.inject({
      method: 'POST',
      url: `/api/agent/pending/${card.id}`,
      headers: { origin: ORIGIN },
      payload: { decision: 'reject' },
    });
    expect((await running).json<PanelActionResult>().outcome).toBe('rejected');
  });

  it('плагины: каталог, обновление, маркетплейс подключить и отключить', async () => {
    const available = (
      await call('list_available_plugins', { query: 'format' })
    ).json<PanelActionResult>();
    expect(available.result).toEqual({
      total: 1,
      offset: 0,
      plugins: [{ id: 'fmt@team', description: 'Formatter', isInstalled: false }],
    });

    const updated = await decided('update_plugin', { id: 'lint@team' });
    expect(updated.result.outcome).toBe('done');
    // Поле охвата плагина подписывалось «Пожелание» — ключом формы генерации тестов.
    expect(updated.card.preview.fields.map((field) => field.label)).toContain('Где установлен');
    expect(JSON.parse(readFileSync(pluginsFile, 'utf8'))[0].version).toBe('9.9.9');

    const added = await decided('add_plugin_marketplace', { source: 'acme/tools' });
    expect(added.card.risk).toBe('danger');
    expect(added.result.outcome).toBe('done');
    const known = () => readFileSync(join(root, 'plugins', 'known_marketplaces.json'), 'utf8');
    expect(JSON.parse(known())).toHaveProperty('tools');
    const listed = (await call('list_plugins', {})).json<PanelActionResult>();
    expect(listed.result).toMatchObject({
      marketplaces: [{ name: 'tools', source: 'acme/tools' }],
    });

    const removed = await decided('remove_plugin_marketplace', { name: 'tools' });
    expect(removed.result.outcome).toBe('done');
    expect(JSON.parse(known())).toEqual({});
  });

  it('аналитика по транскриптам и сравнение CLI — только чтение', async () => {
    const dir = join(paths().projects, 'demo');
    mkdirSync(dir, { recursive: true });
    const at = new Date().toISOString();
    writeFileSync(
      join(dir, 'session.jsonl'),
      [
        JSON.stringify({
          type: 'user',
          uuid: 'u1',
          timestamp: at,
          cwd: base,
          message: { role: 'user', content: 'hi' },
        }),
        JSON.stringify({
          type: 'assistant',
          uuid: 'a1',
          timestamp: at,
          cwd: base,
          message: {
            role: 'assistant',
            model: 'claude-sonnet-4-5',
            content: [{ type: 'text', text: 'ok' }],
            usage: { input_tokens: 120, output_tokens: 30 },
          },
        }),
      ].join('\n') + '\n',
    );
    const analytics = (await call('analytics_summary', { days: 0 })).json<PanelActionResult>();
    expect(analytics.outcome).toBe('done');
    expect(JSON.stringify(analytics.result)).toContain('claude-sonnet-4-5');
  });

  it('compare_providers читает место конфигурации панели и дом процесса, а не настоящий дом', async () => {
    const realHome = homedir();
    const fakeHome = mkdtempSync(join(tmpdir(), 'cc-agent-compare-home-'));
    const saved = {
      HOME: process.env.HOME,
      USERPROFILE: process.env.USERPROFILE,
      CODEX_HOME: process.env.CODEX_HOME,
    };
    try {
      // Дом процесса — временный: чужой CLI читается от него, настоящий дом не трогается.
      process.env.HOME = fakeHome;
      process.env.USERPROFILE = fakeHome;
      delete process.env.CODEX_HOME;
      expect(homedir()).toBe(fakeHome);
      mkdirSync(join(fakeHome, '.codex'), { recursive: true });
      writeFileSync(
        join(fakeHome, '.codex', 'config.toml'),
        '[mcp_servers.marker-codex]\ncommand = "node"\n',
      );
      writeFileSync(
        paths().mcpConfig,
        JSON.stringify({ mcpServers: { 'marker-claude': { command: 'node' } } }),
      );
      const compare = (
        await call('compare_providers', { left: 'claude', right: 'codex' })
      ).json<PanelActionResult>();
      expect(compare.outcome).toBe('done');
      const sections = (
        compare.result as {
          sections: Array<{
            section: string;
            files: { left: string | null; right: string | null };
            entries: Array<{ key: string }>;
          }>;
        }
      ).sections;
      const mcp = sections.find((section) => section.section === 'mcp')!;
      expect(mcp.entries.map((entry) => entry.key).sort()).toEqual([
        'marker-claude',
        'marker-codex',
      ]);
      const files = sections.flatMap((section) =>
        [section.files.left, section.files.right].filter((file): file is string => Boolean(file)),
      );
      expect(files.length).toBeGreaterThan(0);
      // Каждый прочитанный файл — во временном месте панели или во временном доме.
      expect(files.filter((file) => !file.startsWith(base) && !file.startsWith(fakeHome))).toEqual(
        [],
      );
      expect(files.filter((file) => file.startsWith(realHome))).toEqual([]);

      const unknown = (
        await call('compare_providers', { left: 'claude', right: 'nope' })
      ).json<PanelActionResult>();
      expect(unknown.outcome).toBe('failed');
    } finally {
      for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      rmSync(fakeHome, { recursive: true, force: true });
    }
  });

  it('длинные списки: всего, смещение и продолжение — хвост за пределом достижим', async () => {
    type Page = { total: number; offset: number; nextOffset?: number };

    // Каталог плагинов: 61 доступный (установленный lint@team в каталог не входит).
    process.env.CC_FAKE_EXTRA = '60';
    const plugins = async (input: object) =>
      (await call('list_available_plugins', input)).json<PanelActionResult>().result as Page & {
        plugins: Array<{ id: string }>;
      };
    const firstPlugins = await plugins({});
    expect(firstPlugins).toMatchObject({ total: 61, offset: 0, nextOffset: 50 });
    expect(firstPlugins.plugins).toHaveLength(50);
    const restPlugins = await plugins({ offset: 50 });
    expect(restPlugins.plugins).toHaveLength(11);
    expect(restPlugins.plugins.at(-1)?.id).toBe('extra59@team');
    expect(restPlugins.nextOffset).toBeUndefined();

    // Поиск: 120 совпадений при пределе 100 — остаток читается со смещения.
    writeFileSync(
      paths().settings,
      JSON.stringify({
        env: Object.fromEntries(Array.from({ length: 120 }, (_, i) => [`PAGEKEY_${i}`, 'v'])),
      }),
    );
    const search = async (input: object) =>
      (
        await call('search_panel', { query: 'PAGEKEY', limit: 100, ...input })
      ).json<PanelActionResult>().result as Page & { results: unknown[] };
    const firstSearch = await search({});
    expect(firstSearch).toMatchObject({ total: 120, nextOffset: 100 });
    expect(firstSearch.results).toHaveLength(100);
    const restSearch = await search({ offset: 100 });
    expect(restSearch.results).toHaveLength(20);
    expect(restSearch.nextOffset).toBeUndefined();

    // История и копии: две правки, страница по одной.
    for (const text of ['первая правка', 'вторая правка']) {
      const put = await app.inject({
        method: 'PUT',
        url: '/api/claude-md',
        payload: { content: `# Правила\n\n${text}\n` },
      });
      expect(put.statusCode).toBeLessThan(400);
    }
    for (const name of ['list_history', 'list_backups']) {
      const read = async (input: object) =>
        (await call(name, { limit: 1, ...input })).json<PanelActionResult>().result as Page & {
          items: Array<{ name: string }>;
        };
      const head = await read({});
      expect(head).toMatchObject({ total: 2, offset: 0, nextOffset: 1 });
      const tail = await read({ offset: 1 });
      expect(tail.items).toHaveLength(1);
      expect(tail.items[0]?.name).not.toBe(head.items[0]?.name);
      expect(tail.nextOffset).toBeUndefined();
    }

    // Сравнение CLI: 60 записей раздела MCP при пределе 50 на раздел.
    const fakeHome = mkdtempSync(join(tmpdir(), 'cc-agent-compare-page-'));
    const saved = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
    try {
      process.env.HOME = fakeHome;
      process.env.USERPROFILE = fakeHome;
      writeFileSync(
        paths().mcpConfig,
        JSON.stringify({
          mcpServers: Object.fromEntries(
            Array.from({ length: 60 }, (_, i) => [`srv-${i}`, { command: 'node' }]),
          ),
        }),
      );
      type Section = {
        section: string;
        entries: unknown[];
        entriesTotal: number;
        entriesNextOffset?: number;
      };
      const compare = async (input: object) =>
        (
          (
            await call('compare_providers', { left: 'claude', right: 'codex', ...input })
          ).json<PanelActionResult>().result as { sections: Section[] }
        ).sections;
      const mcp = (await compare({})).find((section) => section.section === 'mcp')!;
      expect(mcp).toMatchObject({ entriesTotal: 60, entriesNextOffset: 50 });
      expect(mcp.entries).toHaveLength(50);
      const only = await compare({ section: 'mcp', offset: 50 });
      expect(only.map((section) => section.section)).toEqual(['mcp']);
      expect(only[0]?.entries).toHaveLength(10);
      expect(only[0]?.entriesNextOffset).toBeUndefined();
      // F-298: неизвестный раздел — отказ со списком известных, а не пустой
      // список, который модель читала как «различий нет».
      const unknown = (
        await call('compare_providers', { left: 'claude', right: 'codex', section: 'mpc' })
      ).json<PanelActionResult>();
      expect(unknown.outcome).toBe('failed');
      expect(unknown.message).toContain('«mpc»');
      expect(unknown.message).toContain('mcp');
    } finally {
      for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      rmSync(fakeHome, { recursive: true, force: true });
    }
  });

  it('отказ маршрута чтения назван разделом, а не адресом API', async () => {
    // Промпт запрещает модели рассказывать про вызовы API; адрес в тексте отказа
    // сам подсказывал ей такой рассказ.
    const result = (
      await call('revert_history_hunk', { name: 'no-such-backup', hunk: 0 })
    ).json<PanelActionResult>();
    expect(result.outcome).toBe('failed');
    expect(result.message).toContain('history');
    expect(result.message).toContain('404');
    expect(result.message).not.toContain('/api/');
    expect(await listPending()).toEqual([]);
  });

  it('read_env_passport отдаёт состав среды и ни одного значения секрета', async () => {
    const marker = 'sk-ant-МАРКЕР-АГЕНТА-7d41b0-НЕ-ДОЛЖЕН-УТЕЧЬ';
    writeFileSync(
      paths().settings,
      JSON.stringify({
        env: { ANTHROPIC_API_KEY: marker },
        permissions: { deny: ['Read(./private)'] },
      }),
    );

    const res = (await call('read_env_passport', {})).json<PanelActionResult>();
    expect(res.outcome).toBe('done');

    const passport = res.result as {
      provider: string;
      byKind: Record<string, number>;
      items: Array<{ kind: string }>;
    };
    expect(passport.provider).toBe('claude');
    // Секрет НАЙДЕН и назван — иначе «маркера нет» значило бы лишь, что ключ не
    // прочитан вовсе, и проверка стала бы украшением.
    expect(passport.byKind.secret).toBeGreaterThan(0);
    expect(JSON.stringify(res)).not.toContain(marker);
  });

  it('обрезанный список записей назван обрезанным и не теряет ни одного вида', async () => {
    // Записей заведомо больше предела показа: права дают их сотнями, а список
    // отсортирован по `id` — простая обрезка выбрасывала бы хвост видов целиком.
    writeFileSync(
      paths().settings,
      JSON.stringify({
        env: { EDITOR: 'code' },
        permissions: {
          allow: Array.from({ length: 140 }, (_, index) => `Bash(cmd${index})`),
          deny: ['Read(./private)'],
        },
      }),
    );

    const res = (await call('read_env_passport', {})).json<PanelActionResult>();
    const passport = res.result as {
      byKind: Record<string, number>;
      items: Array<{ kind: string }>;
      itemsShown: number;
      itemsTotal: number;
      itemsTruncated: boolean;
    };

    expect(passport.itemsTruncated).toBe(true);
    expect(passport.itemsTotal).toBeGreaterThan(passport.itemsShown);
    expect(passport.itemsShown).toBe(passport.items.length);
    // Каждый вид, который есть в среде, представлен хотя бы одной записью:
    // иначе модель читает обрезанный список как полный состав среды.
    const shownKinds = new Set(passport.items.map((item) => item.kind));
    for (const kind of Object.keys(passport.byKind)) expect(shownKinds.has(kind)).toBe(true);
  });

  it('[P3] история: откат ханка у НЕ самой свежей копии — отказ до карточки, файл цел', async () => {
    const put = async (content: string): Promise<void> => {
      const answer = await app.inject({
        method: 'PUT',
        url: '/api/claude-md',
        payload: { content },
      });
      expect(answer.statusCode).toBeLessThan(400);
      await new Promise((done) => setTimeout(done, 5));
    };
    await put('# Правила\n\nНоль.\n');
    await put('# Правила\n\nПервая.\n');
    await put('# Правила\n\nПервая.\nВторая.\n');
    const after = readFileSync(paths().claudeMd, 'utf8');
    // Пояс без летнего времени и не UTC: форматтер в UTC дал бы ту же форму
    // строки и прошёл бы проверку по одному шаблону.
    const savedTz = process.env.TZ;
    process.env.TZ = 'Asia/Yekaterinburg';
    let history: PanelActionResult;
    try {
      history = (await call('list_history', {})).json<PanelActionResult>();
    } finally {
      if (savedTz === undefined) delete process.env.TZ;
      else process.env.TZ = savedTz;
    }
    const items = (
      history.result as {
        items: Array<{ name: string; file: string; label: string; at: string; localTime: string }>;
      }
    ).items.filter((item) => item.file === 'CLAUDE.md');
    expect(items.map((item) => item.label).slice(0, 2)).toEqual(['current', 'next']);
    // Время ленты модель называет так же, как его видит человек на странице — местным.
    const plusFive = new Date(Date.parse(items[0]!.at) + 5 * 3_600_000).toISOString();
    expect(items[0]!.localTime).toBe(plusFive.slice(0, 19).replace('T', ' '));

    const refused = (
      await call('revert_history_hunk', { name: items[1]!.name, hunk: 0 })
    ).json<PanelActionResult>();
    expect(refused.outcome).toBe('failed');
    expect(refused.message).toContain('newest');
    expect(await listPending()).toEqual([]);
    expect(readFileSync(paths().claudeMd, 'utf8')).toBe(after);
  });

  it('[P3] restore_backup: карточка показывает, что вернётся — дифф «файл → копия» и время местным', async () => {
    // Живой прогон: у опасного отката файла целиком карточка называла только имя копии
    // и время в UTC — не видно, что откат снесёт и правки, сделанные ПОСЛЕ копии.
    const put = async (content: string): Promise<void> => {
      const answer = await app.inject({
        method: 'PUT',
        url: '/api/claude-md',
        payload: { content },
      });
      expect(answer.statusCode).toBeLessThan(400);
      await new Promise((done) => setTimeout(done, 5));
    };
    await put('# Правила\n\nНоль.\n');
    const key = ['Qw8eRt5yUi', '3oPa7sDf9Gh2'].join('');
    await put(`# Правила\n\nНоль.\nПозже добавлено.\nAPI_TOKEN=${key}\n`);
    const now = readFileSync(paths().claudeMd, 'utf8');
    const copies = (
      (await call('list_backups', {})).json<PanelActionResult>().result as {
        items: Array<{ name: string; target: string; createdAt: string }>;
      }
    ).items.filter((item) => item.target === 'CLAUDE.md');
    // Самая свежая копия — состояние перед последней правкой: «Ноль.» без добавки.
    const newest = [...copies].sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0]!;
    const { card, result } = await decided('restore_backup', { name: newest.name });
    expect(result.outcome).toBe('done');
    expect(card.preview.diff).toContain('-Позже добавлено.');
    // Секрет в удаляемой строке карточка не раскрывает.
    expect(card.preview.diff).not.toContain(key);
    expect(card.preview.fields).toContainEqual(
      expect.objectContaining({
        labelCode: 'label-created',
        value: expect.stringMatching(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/),
      }),
    );
    // Карточка показала ровно то, что сделал откат.
    expect(now).toContain(key);
    expect(readFileSync(paths().claudeMd, 'utf8')).toBe('# Правила\n\nНоль.\n');

    // Файл уже совпадает с копией — пустой карточки нет, отказ до неё.
    const again = (await call('restore_backup', { name: newest.name })).json<PanelActionResult>();
    expect(again.outcome).toBe('failed');
    expect(again.message).toContain('nothing to restore');
    expect(await listPending()).toEqual([]);
  });

  // Ревью z2 C17: дифф отката сверх предела построчного сравнения давал карточку
  // `truncated`, которую одобрить нельзя, — откат через агента был тупиком, и
  // модель узнавала об этом только отказом человеку. Теперь отказ — до карточки.
  it('restore_backup: правка слишком велика для карточки — отказ до неё, с дорогой в «Историю»', async () => {
    const lines = (tag: string) =>
      Array.from({ length: 2100 }, (_, index) => `${tag} ${index}`).join('\n');
    for (const content of [`${lines('старое')}\n`, `${lines('новое')}\n`]) {
      const answer = await app.inject({
        method: 'PUT',
        url: '/api/claude-md',
        payload: { content },
      });
      expect(answer.statusCode).toBeLessThan(400);
      await new Promise((done) => setTimeout(done, 5));
    }
    const newest = (
      (await call('list_backups', {})).json<PanelActionResult>().result as {
        items: Array<{ name: string; target: string; createdAt: string }>;
      }
    ).items
      .filter((item) => item.target === 'CLAUDE.md')
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0]!;

    const refused = (await call('restore_backup', { name: newest.name })).json<PanelActionResult>();

    expect(refused.outcome).toBe('failed');
    expect(refused.message).toContain('History page');
    expect(await listPending()).toEqual([]);
  });

  // Ревью 26.09: отпечаток видел копию и ленту, но не живой файл — правка мимо
  // панели (без новой копии) меняла, что снесёт откат, а клик выполнял старую карточку.
  it('restore_backup: файл поправлен мимо панели после показа — stale_preview, правка цела', async () => {
    const put = async (content: string): Promise<void> => {
      const answer = await app.inject({
        method: 'PUT',
        url: '/api/claude-md',
        payload: { content },
      });
      expect(answer.statusCode).toBeLessThan(400);
      await new Promise((done) => setTimeout(done, 5));
    };
    await put('# Правила\n\nРаз.\n');
    await put('# Правила\n\nРаз.\nДва.\n');
    const copies = (
      (await call('list_backups', {})).json<PanelActionResult>().result as {
        items: Array<{ name: string; target: string; createdAt: string }>;
      }
    ).items.filter((item) => item.target === 'CLAUDE.md');
    const newest = [...copies].sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0]!;
    const running = call('restore_backup', { name: newest.name });
    const card = await waitPending();
    const byHand = '# Правила\n\nРаз.\nДва.\nРукой, мимо панели.\n';
    writeFileSync(paths().claudeMd, byHand);
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
    expect(readFileSync(paths().claudeMd, 'utf8')).toBe(byHand);
  });
});
