import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { ProviderPluginsInfo } from '@agentdeck/contracts';
import { AppStore } from '../lib/app-store.ts';
import type { ServerContext } from '../context.ts';
import type { QwenCliResult } from '../domains/provider-plugins.ts';
import { registerProviderPluginsRoutes } from './provider-plugins-routes.ts';

/**
 * MAP 25, маршруты плагинов Codex: `/api/provider-plugins`, `/installed`,
 * `/marketplaces`. Дом — временный `CODEX_HOME`, CLI — подменённый запуск (что
 * делает настоящий codex, проверяет `tools/qa/check-codex-plugins.mjs`).
 * Смотрим: JSON CLI доезжает до ответа вместе с содержимым кэша, аргументы CLI,
 * включение пишет ровно строку config.toml с копией, отказы с кодами.
 */
describe('provider-plugins-routes: плагины Codex', () => {
  let appDataRoot: string;
  let codexHome: string;
  let previousHome: string | undefined;
  let app: FastifyInstance;
  let calls: string[][];
  let answer: (args: string[]) => Partial<QwenCliResult>;

  const configPath = (): string => join(codexHome, 'config.toml');
  const CONFIG = `model = "gpt-5"

[marketplaces.qa-mkt]
source_type = "local"
source = 'C:\\mkt'

[plugins."hello@qa-mkt"]
enabled = true
`;
  const entry = (installed: boolean, enabled: boolean) => ({
    pluginId: 'hello@qa-mkt',
    name: 'hello',
    marketplaceName: 'qa-mkt',
    version: '1.0.0',
    installed,
    enabled,
    source: { source: 'local', path: 'C:\\mkt\\plugins\\hello' },
  });
  const listJson = (installed = true) =>
    JSON.stringify({
      installed: installed ? [entry(true, true)] : [],
      available: installed ? [] : [entry(false, false)],
    });

  const boot = async (provider = 'codex'): Promise<void> => {
    const store = new AppStore(appDataRoot);
    store.updateSettings({ provider });
    const ctx = { store, backupDir: join(appDataRoot, 'backups') } as unknown as ServerContext;
    app = Fastify();
    registerProviderPluginsRoutes(app, ctx, {
      codexRun: () => async (args) => {
        calls.push(args);
        return { code: 0, stdout: '{}', stderr: '', timedOut: false, ...answer(args) };
      },
    });
    await app.ready();
  };

  beforeEach(() => {
    appDataRoot = mkdtempSync(join(tmpdir(), 'cc-appdata-'));
    codexHome = mkdtempSync(join(tmpdir(), 'cc-codex-'));
    const cached = join(codexHome, 'plugins', 'cache', 'qa-mkt', 'hello', '1.0.0');
    mkdirSync(join(cached, '.codex-plugin'), { recursive: true });
    mkdirSync(join(cached, 'skills', 'greet'), { recursive: true });
    writeFileSync(
      join(cached, '.codex-plugin', 'plugin.json'),
      JSON.stringify({
        name: 'hello',
        description: 'Hello plugin',
        interface: { displayName: 'Hello' },
      }),
    );
    writeFileSync(join(cached, '.mcp.json'), JSON.stringify({ mcpServers: { db: {} } }));
    writeFileSync(configPath(), CONFIG);
    previousHome = process.env.CODEX_HOME;
    process.env.CODEX_HOME = codexHome;
    calls = [];
    answer = (args) => {
      if (args[0] === 'list') return { stdout: listJson() };
      if (args[0] === 'marketplace' && args[1] === 'list') {
        return { stdout: JSON.stringify({ marketplaces: [{ name: 'qa-mkt', root: 'C:\\mkt' }] }) };
      }
      return { stdout: '{"ok":true}' };
    };
  });

  afterEach(async () => {
    await app?.close();
    if (previousHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = previousHome;
    rmSync(appDataRoot, { recursive: true, force: true });
    rmSync(codexHome, { recursive: true, force: true });
  });

  it('GET: списки CLI + содержимое кэша; рынки; действия разрешены', async () => {
    await boot();
    const res = await app.inject({ method: 'GET', url: '/api/provider-plugins' });
    expect(res.statusCode).toBe(200);
    const info = res.json<ProviderPluginsInfo>();
    expect(info).toMatchObject({
      format: 'codex-plugins',
      installedActions: true,
      marketplaceActions: true,
      pluginsDir: join(codexHome, 'plugins'),
      marketplaces: [{ name: 'qa-mkt', root: 'C:\\mkt' }],
      available: [],
    });
    expect(info.installed[0]).toMatchObject({
      id: 'hello@qa-mkt',
      displayName: 'Hello',
      description: 'Hello plugin',
      marketplace: 'qa-mkt',
      enabled: true,
      hasSkills: true,
      mcpServers: ['db'],
    });
    expect(calls).toEqual([
      ['list', '--json', '--available'],
      ['marketplace', 'list', '--json'],
    ]);
  });

  it('GET: CLI отказал — причина в installedStateError, списки пусты', async () => {
    answer = () => ({ code: 1, stdout: '', stderr: 'boom' });
    await boot();
    const info = (
      await app.inject({ method: 'GET', url: '/api/provider-plugins' })
    ).json<ProviderPluginsInfo>();
    expect(info.installed).toEqual([]);
    expect(info.installedStateError).toBe('boom\nboom');
  });

  it('install / remove / рынки уходят в CLI с нужными аргументами', async () => {
    await boot();
    const ok = async (method: 'POST' | 'DELETE', url: string, payload?: object) => {
      const res = await app.inject({ method, url, ...(payload ? { payload } : {}) });
      expect(res.statusCode, url).toBe(200);
    };
    await ok('POST', '/api/provider-plugins/installed', { source: ' hello@qa-mkt ' });
    await ok('DELETE', '/api/provider-plugins/installed/hello%40qa-mkt');
    await ok('POST', '/api/provider-plugins/marketplaces', { source: 'owner/repo@main' });
    await ok('POST', '/api/provider-plugins/marketplaces/qa-mkt/upgrade');
    await ok('DELETE', '/api/provider-plugins/marketplaces/qa-mkt');
    expect(calls).toEqual([
      ['add', 'hello@qa-mkt', '--json'],
      ['list', '--json'],
      ['remove', 'hello@qa-mkt', '--json'],
      ['marketplace', 'add', 'owner/repo@main', '--json'],
      ['marketplace', 'list', '--json'],
      ['marketplace', 'upgrade', 'qa-mkt', '--json'],
      ['marketplace', 'list', '--json'],
      ['marketplace', 'remove', 'qa-mkt', '--json'],
    ]);
  });

  it('выключение: ровно строка enabled в config.toml, резервная копия, CLI не пишет', async () => {
    await boot();
    const off = await app.inject({
      method: 'POST',
      url: '/api/provider-plugins/installed/hello%40qa-mkt/disable',
    });
    expect(off.statusCode).toBe(200);
    expect(readFileSync(configPath(), 'utf8')).toBe(
      CONFIG.replace('enabled = true', 'enabled = false'),
    );
    expect(off.json<{ backupPath?: string }>().backupPath).toBeTruthy();
    expect(readdirSync(join(appDataRoot, 'backups')).length).toBeGreaterThan(0);
    expect(calls).toEqual([['list', '--json']]);
  });

  it('отказы: селектор 400, чужой плагин и рынок 404, нет таблицы 422, отказ CLI 422', async () => {
    await boot();
    const bad = await app.inject({
      method: 'POST',
      url: '/api/provider-plugins/installed',
      payload: { source: '--help' },
    });
    expect(bad.statusCode).toBe(400);
    expect(bad.json()).toMatchObject({ messageCode: 'codex-plugin-selector-invalid' });
    const badSource = await app.inject({
      method: 'POST',
      url: '/api/provider-plugins/marketplaces',
      payload: { source: '-x' },
    });
    expect(badSource.json()).toMatchObject({ messageCode: 'codex-marketplace-source-invalid' });
    expect(calls).toEqual([]);

    const ghost = await app.inject({
      method: 'DELETE',
      url: '/api/provider-plugins/installed/ghost%40qa-mkt',
    });
    expect(ghost.statusCode).toBe(404);
    expect(ghost.json()).toMatchObject({
      messageCode: 'codex-plugin-not-found',
      params: { name: 'ghost@qa-mkt' },
    });
    const market = await app.inject({
      method: 'DELETE',
      url: '/api/provider-plugins/marketplaces/nope',
    });
    expect(market.statusCode).toBe(404);
    expect(calls.some((args) => args[0] === 'remove' || args[1] === 'remove')).toBe(false);

    writeFileSync(configPath(), 'model = "gpt-5"\n');
    const toggle = await app.inject({
      method: 'POST',
      url: '/api/provider-plugins/installed/hello%40qa-mkt/disable',
    });
    expect(toggle.statusCode).toBe(422);
    expect(toggle.json()).toMatchObject({ messageCode: 'codex-plugin-toggle-unrecognized' });
    expect(readFileSync(configPath(), 'utf8')).toBe('model = "gpt-5"\n');

    answer = () => ({ code: 1, stdout: '', stderr: 'Error: plugin `nope` was not found' });
    const failed = await app.inject({
      method: 'POST',
      url: '/api/provider-plugins/installed',
      payload: { source: 'nope@qa-mkt' },
    });
    expect(failed.statusCode).toBe(422);
    expect(failed.json()).toMatchObject({
      messageCode: 'codex-plugin-cli-failed',
      params: { reason: 'Error: plugin `nope` was not found' },
    });
  });

  it('файловые маршруты в кэш не пишут — 409; у Qwen рынков нет — 409', async () => {
    await boot();
    const put = await app.inject({
      method: 'PUT',
      url: '/api/provider-plugins/file',
      payload: { path: 'evil.js', content: 'x' },
    });
    expect(put.statusCode).toBe(409);
    expect(put.json()).toMatchObject({ messageCode: 'codex-plugins-files-readonly' });
    await app.close();

    await boot('qwen');
    const res = await app.inject({
      method: 'POST',
      url: '/api/provider-plugins/marketplaces',
      payload: { source: 'x' },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ messageCode: 'plugin-marketplaces-unsupported' });
  });
});
