import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import { tmpdir } from 'node:os';
import type { SplitDefaultsView } from '@agentdeck/contracts/split-groups';
import { AppStore } from '../../../lib/app-store/app-store.ts';
import type { ServerContext } from '../../../context.ts';
import { resetCliLookupCache } from '../../../providers/detect/detect.ts';
import { resetCliInfoCache } from '../../../providers/cli-install/cli-install.ts';
import { BackgroundWatcher } from '../../../domains/watcher/watcher.ts';
import { ModelCatalogStore } from '../../../domains/models/model-store.ts';
import { FormatCheckStore } from '../../../domains/format-check/format-check.ts';
import { registerSplitDefaultsRoutes } from '../../split-defaults-routes/split-defaults-routes.ts';
import { registerWatcherRoutes } from '../../watcher-routes/watcher-routes.ts';
import { registerModelRoutes } from '../../model-routes/model-routes.ts';
import { registerFormatCheckRoutes } from '../../format-check-routes/format-check-routes.ts';
import { registerConfigRoutes } from '../../config-routes/config-routes.ts';
import { registerChatCliRoutes } from '../../chat/cli-routes/cli-routes.ts';
import { manageHarness, type ManageHarness } from '../manage-test-harness.ts';

/**
 * Действия настроек сверх общих — на настоящих маршрутах вкладок: общие правила
 * групп, наблюдатель, каталог моделей, сверка форматов, учётная запись и CLI.
 * CLI — ФАЛЬШИВЫЙ `claude` на PATH (настоящий процесс, свой файл версии);
 * сеть каталога и схем — подменённый `fetch` (внешняя граница). Доказательство
 * записи — состояние на диске, прочитанное новым хранилищем, а не ответ действия.
 */
const isWindows = process.platform === 'win32';
const LEAKED = 'sk-ant-api03-LEAKEDLEAKEDLEAKEDLEAKEDLEAKED0000';

const FAKE_CLI = `
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
const state = process.env.CC_FAKE_CLI_STATE;
const version = existsSync(state) ? readFileSync(state, 'utf8').trim() : '1.0.0';
const [verb] = process.argv.slice(2);
if (verb === '--version') { process.stdout.write(version + ' (Claude Code)\\n'); process.exit(0); }
if (verb === 'update') {
  if (process.env.CC_FAKE_UPDATE_FAIL) { process.stderr.write('update failed, token ${LEAKED}'); process.exit(1); }
  writeFileSync(state, '1.0.1');
  process.stdout.write('Updated from ' + version + ' to 1.0.1');
  process.exit(0);
}
process.exit(2);
`;

const CATALOG = {
  anthropic: {
    id: 'anthropic',
    models: {
      'claude-opus-5': {
        id: 'claude-opus-5',
        name: 'Claude Opus 5',
        family: 'claude-opus',
        release_date: '2026-07-24',
      },
      'claude-sonnet-5': {
        id: 'claude-sonnet-5',
        name: 'Claude Sonnet 5',
        family: 'claude-sonnet',
        release_date: '2026-07-24',
      },
    },
  },
};
const SCHEMA = {
  properties: { mcp: {}, permission: {}, plugin: {}, experimental: { properties: { hook: {} } } },
};

describe('panel-agent actions: settings extra', () => {
  let base: string;
  let root: string;
  let appData: string;
  let bin: string;
  let cliState: string;
  let store: AppStore;
  let watcher: BackgroundWatcher;
  let h: ManageHarness;
  const savedPath = process.env.PATH;

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
    base = mkdtempSync(join(tmpdir(), 'cc-agent-settings-x-'));
    root = join(base, '.claude');
    appData = join(root, 'agentdeck');
    mkdirSync(appData, { recursive: true });
    writeFileSync(paths().mcpConfig, '{}\n');

    bin = mkdtempSync(join(tmpdir(), 'cc-agent-settings-x-bin-'));
    cliState = join(bin, 'version.txt');
    const script = join(bin, 'fake-claude.mjs');
    writeFileSync(script, FAKE_CLI, 'utf8');
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
    process.env.CC_FAKE_CLI_STATE = cliState;
    delete process.env.CC_FAKE_UPDATE_FAIL;
    resetCliLookupCache();
    resetCliInfoCache();

    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string | URL) =>
        String(url).includes('models.dev')
          ? new Response(JSON.stringify(CATALOG), { status: 200 })
          : new Response(JSON.stringify(SCHEMA), { status: 200 }),
      ),
    );

    store = new AppStore(appData);
    watcher = new BackgroundWatcher({
      appDataDir: () => appData,
      reportPath: () => join(appData, 'WATCH-REPORT.md'),
      cwd: appData,
      resolveCommand: () => undefined,
      model: () => undefined,
      pricing: () => ({}),
      debounceMs: 10_000,
    });
    const ctx = {
      store,
      location: {
        paths: paths(),
        source: 'default',
        isValid: true,
        missing: [],
      },
      backupDir: join(appData, 'backups'),
      models: new ModelCatalogStore(appData),
      formatCheck: new FormatCheckStore(appData),
      applyIoSettings: () => {},
      relocate: () => ({ isValid: true }),
      rememberDirOverride: () => {},
      effectiveSettings: () => store.getSettings(),
    } as unknown as ServerContext;
    h = await manageHarness(ctx, (app) => {
      registerConfigRoutes(app, ctx);
      registerSplitDefaultsRoutes(app, ctx);
      registerWatcherRoutes(app, ctx, watcher);
      registerModelRoutes(app, ctx);
      registerFormatCheckRoutes(app, ctx);
      registerChatCliRoutes(app);
    });
  });

  afterEach(async () => {
    await h.close();
    watcher.shutdown();
    vi.unstubAllGlobals();
    process.env.PATH = savedPath;
    delete process.env.CC_FAKE_CLI_STATE;
    delete process.env.CC_FAKE_UPDATE_FAIL;
    resetCliLookupCache();
    resetCliInfoCache();
    for (const dir of [base, bin]) {
      rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  });

  const call = (name: string, input: unknown) => h.call(name, input);
  const decided = (name: string, input: unknown, decision?: 'approve' | 'reject') =>
    h.decided(name, input, decision);
  /** Правила групп с диска — новым хранилищем, мимо памяти маршрута. */
  const splitOnDisk = () => new AppStore(appData).getSplitDefaults();

  it('общие правила групп: читает числа, правит только названные, права групп не трогает', async () => {
    // Человек поставил своё право группы — агент не должен его сбросить.
    const human = await h.app.inject({
      method: 'PUT',
      url: '/api/split-defaults',
      headers: { origin: 'http://localhost:8888' },
      payload: {
        ...splitOnDisk(),
        permissions: { ...splitOnDisk().permissions, gitWrite: 'human' },
        groupQuestions: 'human',
      },
    });
    expect(human.statusCode).toBe(200);

    const read = await call('read_split_defaults', {});
    expect(read.outcome).toBe('done');
    const view = read.result as { current: { parallelLight: number }; humanOnly: unknown };
    expect(view.humanOnly).toMatchObject({
      permissions: { gitWrite: 'human' },
      groupQuestions: 'human',
    });

    const next = view.current.parallelLight === 2 ? 3 : 2;
    const { card, result } = await decided('save_split_defaults', {
      parallelLight: next,
      heavySteps: 7,
    });
    expect(result.outcome).toBe('done');
    expect(card.risk).toBe('change');
    expect(card.preview.diff).toContain(`"parallelLight": ${next}`);
    const disk = splitOnDisk();
    expect(disk.parallelLight).toBe(next);
    expect(disk.heavy.steps).toBe(7);
    expect(disk.permissions.gitWrite).toBe('human');
    expect(disk.groupQuestions).toBe('human');

    // Неназванное число тяжёлой группы остаётся тем, что на диске.
    const chains = disk.heavy.chains === 2 ? 3 : 2;
    await decided('save_split_defaults', { heavyChains: chains });
    expect(splitOnDisk().heavy).toEqual({ chains, steps: 7 });
  });

  it('общие правила групп: отказ человека ничего не пишет; пустой вход и право группы — не принимаются', async () => {
    const before = splitOnDisk();
    const { result } = await decided('save_split_defaults', { parallelHeavy: 1 }, 'reject');
    expect(result.outcome).toBe('rejected');
    expect(splitOnDisk()).toEqual(before);

    const empty = await call('save_split_defaults', {});
    expect(empty.outcome).toBe('invalid');
    // Поле прав во входе не существует: схема его отбрасывает, запись без чисел — отказ.
    const permissions = await call('save_split_defaults', { permissions: { gitWrite: 'auto' } });
    expect(permissions.outcome).toBe('invalid');
    expect(splitOnDisk()).toEqual(before);
    expect(await h.pendingCards()).toEqual([]);
  });

  it('наблюдатель: статус, включение карточкой, повтор того же состояния — отказ до карточки', async () => {
    const status = await call('watcher_status', {});
    expect(status.outcome).toBe('done');
    expect((status.result as { enabled: boolean }).enabled).toBe(false);

    const { card, result } = await decided('set_watcher', { enabled: true });
    expect(result.outcome).toBe('done');
    expect(card.preview.summaryCode).toBe('summary-watcher-on');
    expect(watcher.status().enabled).toBe(true);

    const again = await call('set_watcher', { enabled: true });
    expect(again.outcome).toBe('failed');
    expect(again.message).toContain('already on');
    expect(await h.pendingCards()).toEqual([]);

    await decided('set_watcher', { enabled: false });
    expect(watcher.status().enabled).toBe(false);
  });

  it('каталог моделей: страницы с продолжением; предел страницы вне схемы — отказ', async () => {
    const first = await call('list_models', { limit: 1 });
    expect(first.outcome).toBe('done');
    const page = first.result as { total: number; nextOffset?: number; models: { id: string }[] };
    expect(page.total).toBe(2);
    expect(page.models).toHaveLength(1);
    expect(page.nextOffset).toBe(1);
    const second = (await call('list_models', { offset: 1, limit: 1 })).result as {
      nextOffset?: number;
      models: { id: string }[];
    };
    expect(second.nextOffset).toBeUndefined();
    expect([page.models[0]!.id, second.models[0]!.id].sort()).toEqual([
      'claude-opus-5',
      'claude-sonnet-5',
    ]);

    expect((await call('list_models', { limit: 0 })).outcome).toBe('invalid');
  });

  it('сверка форматов: без проверки честно «ни разу», по просьбе — отчёт по каждому CLI', async () => {
    const cached = await call('format_check', {});
    expect(cached.outcome).toBe('done');
    expect(cached.result).toMatchObject({ checked: false });

    const fresh = await call('format_check', { refresh: true });
    expect(fresh.outcome).toBe('done');
    const report = fresh.result as {
      checked: boolean;
      providers: { cli: string; state: string }[];
    };
    expect(report.checked).toBe(true);
    expect(report.providers.find((row) => row.cli === 'opencode')?.state).toBe('ok');
  });

  it('учётная запись: без входа — «не вошли»; с входом — почта, система и папка конфигурации', async () => {
    const out = await call('read_account', {});
    expect(out.outcome).toBe('done');
    expect(out.result).toMatchObject({
      account: { signedIn: false },
      configFolder: { root, valid: true },
    });

    writeFileSync(
      paths().mcpConfig,
      JSON.stringify({
        oauthAccount: { emailAddress: 'dev@example.com', billingType: 'stripe_subscription' },
      }),
    );
    const signed = (await call('read_account', {})).result as {
      account: { email?: string; isSubscription?: boolean };
      system: { platform?: string };
    };
    expect(signed.account).toMatchObject({ email: 'dev@example.com', isSubscription: true });
    expect(signed.system.platform).toBe(process.platform);
  });

  it('CLI: версия фальшивой копии; обновление карточкой — версия на диске новая', async () => {
    const version = await call('cli_version', {});
    expect(version.outcome).toBe('done');
    expect(version.result).toMatchObject({ found: true, version: '1.0.0' });

    const { card, result } = await decided('update_cli', {});
    expect(card.risk).toBe('danger');
    expect(card.preview.fields.map((field) => field.value)).toContain('1.0.0');
    expect(result.outcome).toBe('done');
    expect(result.result).toMatchObject({ updated: true, version: '1.0.1' });
    expect(readFileSync(cliState, 'utf8')).toBe('1.0.1');
  });

  it('CLI: провал `claude update` — исход failed с маской секрета; без CLI в PATH — отказ до карточки', async () => {
    process.env.CC_FAKE_UPDATE_FAIL = '1';
    const { result } = await decided('update_cli', {});
    expect(result.outcome).toBe('failed');
    expect(result.message).toContain('claude update failed');
    expect(JSON.stringify(result)).not.toContain(LEAKED);

    rmSync(join(bin, isWindows ? 'claude.cmd' : 'claude'));
    resetCliInfoCache();
    resetCliLookupCache();
    const missing = await call('update_cli', {});
    expect(missing.outcome).toBe('failed');
    expect(missing.message).toContain('not found');
    expect(await h.pendingCards()).toEqual([]);
  });

  it('чтения правил групп отвечают тем же, что вкладка', async () => {
    const view = (
      await h.app.inject({ method: 'GET', url: '/api/split-defaults' })
    ).json<SplitDefaultsView>();
    const read = (await call('read_split_defaults', {})).result as { builtIn: unknown };
    expect(read.builtIn).toEqual({
      parallelLight: view.builtIn.parallelLight,
      parallelHeavy: view.builtIn.parallelHeavy,
      heavy: view.builtIn.heavy,
    });
  });
});
