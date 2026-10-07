import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { ProviderPluginsInfo } from '@agentdeck/contracts';
import { AppStore } from '../lib/app-store.ts';
import type { ServerContext } from '../context.ts';
import type { QwenCliResult } from '../domains/provider-plugins.ts';
import { registerProviderPluginsRoutes } from './provider-plugins-routes.ts';

/**
 * MAP 25, маршруты расширений Qwen: `/api/provider-plugins` + `/installed`.
 * Каталог — временный `QWEN_HOME`, CLI — подменённый запуск (что делает
 * настоящий qwen, проверяет `tools/qa/check-qwen-extensions.mjs`). Смотрим:
 * отметки ✓/✗ доезжают до ответа, аргументы CLI, отказы с кодами, и что
 * файловые маршруты в каталог расширений не пишут.
 */
describe('provider-plugins-routes: расширения Qwen', () => {
  let appDataRoot: string;
  let qwenHome: string;
  let previousHome: string | undefined;
  let app: FastifyInstance;
  let calls: { command: string; args: string[] }[];
  let answer: (args: string[]) => Partial<QwenCliResult>;

  const extensionsDir = (): string => join(qwenHome, 'extensions');

  const boot = async (provider = 'qwen'): Promise<void> => {
    const store = new AppStore(appDataRoot);
    store.updateSettings({ provider });
    const ctx = { store, backupDir: join(appDataRoot, 'backups') } as unknown as ServerContext;
    app = Fastify();
    registerProviderPluginsRoutes(app, ctx, {
      qwenRun: (command) => async (args) => {
        calls.push({ command, args });
        return { code: 0, stdout: '', stderr: '', timedOut: false, ...answer(args) };
      },
    });
    await app.ready();
  };

  beforeEach(() => {
    appDataRoot = mkdtempSync(join(tmpdir(), 'cc-appdata-'));
    qwenHome = mkdtempSync(join(tmpdir(), 'cc-qwen-'));
    mkdirSync(join(extensionsDir(), 'alpha'), { recursive: true });
    writeFileSync(
      join(extensionsDir(), 'alpha', 'qwen-extension.json'),
      JSON.stringify({ name: 'alpha', version: '0.1.0', description: 'Alpha ext' }),
    );
    previousHome = process.env.QWEN_HOME;
    process.env.QWEN_HOME = qwenHome;
    calls = [];
    answer = (args) =>
      args[0] === 'list'
        ? { stdout: `✗ alpha (0.1.0)\n Путь: ${join(extensionsDir(), 'alpha')}\n` }
        : { stdout: 'done' };
  });

  afterEach(async () => {
    await app?.close();
    if (previousHome === undefined) delete process.env.QWEN_HOME;
    else process.env.QWEN_HOME = previousHome;
    rmSync(appDataRoot, { recursive: true, force: true });
    rmSync(qwenHome, { recursive: true, force: true });
  });

  it('GET: манифест + отметка из list; CLI зовётся командой провайдера', async () => {
    await boot();
    const res = await app.inject({ method: 'GET', url: '/api/provider-plugins' });
    expect(res.statusCode).toBe(200);
    const info = res.json<ProviderPluginsInfo>();
    expect(info).toMatchObject({ format: 'qwen-extensions', installedActions: true });
    expect(info.installed[0]).toMatchObject({
      id: 'alpha',
      description: 'Alpha ext',
      enabled: false,
    });
    expect(calls).toEqual([
      { command: process.platform === 'win32' ? 'qwen.cmd' : 'qwen', args: ['list'] },
    ]);
  });

  it('GET: CLI отказал — список есть, причина в installedStateError', async () => {
    answer = () => ({ code: 1, stderr: 'not logged' });
    await boot();
    const info = (
      await app.inject({ method: 'GET', url: '/api/provider-plugins' })
    ).json<ProviderPluginsInfo>();
    expect(info.installed).toHaveLength(1);
    expect(info.installed[0]!.enabled).toBeUndefined();
    expect(info.installedStateError).toBe('not logged');
  });

  it('install / enable / disable / uninstall уходят в CLI с нужными аргументами', async () => {
    await boot();
    const install = await app.inject({
      method: 'POST',
      url: '/api/provider-plugins/installed',
      payload: { source: 'https://github.com/o/r' },
    });
    expect(install.statusCode).toBe(200);
    expect(install.json()).toMatchObject({ ok: true, output: 'done', needsRestart: true });
    for (const action of ['disable', 'enable']) {
      const res = await app.inject({
        method: 'POST',
        url: `/api/provider-plugins/installed/alpha/${action}`,
      });
      expect(res.statusCode, action).toBe(200);
    }
    const removed = await app.inject({
      method: 'DELETE',
      url: '/api/provider-plugins/installed/alpha',
    });
    expect(removed.statusCode).toBe(200);
    expect(calls.map((call) => call.args)).toEqual([
      ['install', '--consent', 'https://github.com/o/r'],
      ['disable', '--scope', 'user', 'alpha'],
      ['enable', '--scope', 'user', 'alpha'],
      ['uninstall', 'alpha'],
    ]);
  });

  it('отказы: плохой источник 400, чужое имя 404, неизвестное действие 400, отказ CLI 422', async () => {
    await boot();
    const bad = await app.inject({
      method: 'POST',
      url: '/api/provider-plugins/installed',
      payload: { source: '--help' },
    });
    expect(bad.statusCode).toBe(400);
    expect(bad.json()).toMatchObject({ messageCode: 'qwen-extension-source-invalid' });

    const missing = await app.inject({
      method: 'DELETE',
      url: '/api/provider-plugins/installed/ghost',
    });
    expect(missing.statusCode).toBe(404);
    expect(missing.json()).toMatchObject({ params: { name: 'ghost' } });

    const action = await app.inject({
      method: 'POST',
      url: '/api/provider-plugins/installed/alpha/update',
    });
    expect(action.statusCode).toBe(400);
    expect(calls).toEqual([]);

    answer = () => ({ code: 1, stderr: 'Extension "alpha" is already installed.' });
    const failed = await app.inject({
      method: 'POST',
      url: '/api/provider-plugins/installed',
      payload: { source: 'C:/src/alpha' },
    });
    expect(failed.statusCode).toBe(422);
    expect(failed.json()).toMatchObject({
      messageCode: 'qwen-extension-cli-failed',
      params: { reason: 'Extension "alpha" is already installed.' },
    });
  });

  it('файловые маршруты в каталог расширений не пишут — 409', async () => {
    await boot();
    const before = readdirSync(extensionsDir());
    const put = await app.inject({
      method: 'PUT',
      url: '/api/provider-plugins/file',
      payload: { path: 'evil.js', content: 'x' },
    });
    expect(put.statusCode).toBe(409);
    expect(put.json()).toMatchObject({ messageCode: 'qwen-extensions-files-readonly' });
    const packages = await app.inject({
      method: 'PUT',
      url: '/api/provider-plugins/packages',
      payload: { packages: ['a'] },
    });
    expect(packages.statusCode).toBe(409);
    expect(readdirSync(extensionsDir())).toEqual(before);
  });

  it('у OpenCode действий над установленным нет — 409', async () => {
    await boot('opencode');
    const res = await app.inject({
      method: 'POST',
      url: '/api/provider-plugins/installed',
      payload: { source: 'x' },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ messageCode: 'installed-actions-unsupported' });
  });
});
