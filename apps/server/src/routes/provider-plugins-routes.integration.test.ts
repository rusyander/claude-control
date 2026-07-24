import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import type { ProviderPluginsInfo } from '@claude-control/contracts';
import { AppStore } from '../lib/app-store.ts';
import type { ServerContext } from '../context.ts';
import { registerProviderPluginsRoutes } from './provider-plugins-routes.ts';

/**
 * OPENCODE-4, маршруты: `/api/provider-plugins` (+ `/file`, `/packages`).
 *
 * Проверяем на ВРЕМЕННОМ каталоге конфигурации (`XDG_CONFIG_HOME`) — реальный
 * `~` не трогается. Смотрим главное: раздел доступен ТОЛЬКО у opencode,
 * round-trip файла, ЗАЩИТА ПУТЕЙ отвечает 400 `unsafe_path` (а не 404) на
 * чтении, записи и удалении, npm-список правится с сохранением чужих ключей,
 * битый конфиг → readOnly + 422.
 */
describe('provider-plugins-routes: плагины CLI провайдера', () => {
  let appDataRoot: string;
  let xdgRoot: string;
  let pluginsDir: string;
  let configFile: string;
  let app: FastifyInstance;
  let previousXdg: string | undefined;
  let previousConfig: string | undefined;

  const boot = async (provider: string): Promise<void> => {
    const store = new AppStore(appDataRoot);
    if (provider !== 'claude') store.updateSettings({ provider });

    const ctx = { store, backupDir: join(appDataRoot, 'backups') } as unknown as ServerContext;
    app = Fastify();
    registerProviderPluginsRoutes(app, ctx);
    await app.ready();
  };

  beforeEach(() => {
    appDataRoot = mkdtempSync(join(tmpdir(), 'cc-appdata-'));
    xdgRoot = mkdtempSync(join(tmpdir(), 'cc-xdg-'));
    pluginsDir = join(xdgRoot, 'opencode', 'plugins');
    configFile = join(xdgRoot, 'opencode', 'opencode.json');
    mkdirSync(dirname(configFile), { recursive: true });

    previousXdg = process.env.XDG_CONFIG_HOME;
    previousConfig = process.env.OPENCODE_CONFIG;
    process.env.XDG_CONFIG_HOME = xdgRoot;
    // Файл конфигурации не переносим: он должен резолвиться внутри XDG-каталога.
    delete process.env.OPENCODE_CONFIG;
  });

  afterEach(async () => {
    await app?.close();
    if (previousXdg === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = previousXdg;
    if (previousConfig !== undefined) process.env.OPENCODE_CONFIG = previousConfig;
    rmSync(appDataRoot, { recursive: true, force: true });
    rmSync(xdgRoot, { recursive: true, force: true });
  });

  it('раздел доступен только у opencode: у claude и прочих — 400', async () => {
    for (const provider of ['claude', 'codex', 'gemini', 'cursor', 'aider']) {
      await boot(provider);
      for (const url of ['/api/provider-plugins', '/api/provider-plugins/file?path=a.ts']) {
        const res = await app.inject({ method: 'GET', url });
        expect(res.statusCode, `${provider} ${url}`).toBe(400);
        expect(res.json<{ error: string }>().error).toBe('section_unsupported');
      }
      const put = await app.inject({
        method: 'PUT',
        url: '/api/provider-plugins/file',
        payload: { path: 'a.ts', content: 'x' },
      });
      expect(put.statusCode, provider).toBe(400);

      const packages = await app.inject({
        method: 'PUT',
        url: '/api/provider-plugins/packages',
        payload: { packages: ['a'] },
      });
      expect(packages.statusCode, provider).toBe(400);
      await app.close();
    }
    expect(existsSync(pluginsDir)).toBe(false);
  });

  it('opencode: пути каталога и конфига берутся из XDG, каталог не создаётся', async () => {
    await boot('opencode');
    const res = await app.inject({ method: 'GET', url: '/api/provider-plugins' });
    expect(res.statusCode).toBe(200);

    const info = res.json<ProviderPluginsInfo>();
    expect(info.providerId).toBe('opencode');
    expect(info.pluginsDir).toBe(pluginsDir);
    expect(info.configPath).toBe(configFile);
    expect(info.dirExists).toBe(false);
    expect(info.files).toEqual([]);
    expect(existsSync(pluginsDir)).toBe(false);
  });

  it('round-trip файла плагина: создание → список → чтение → правка → удаление', async () => {
    await boot('opencode');

    const created = await app.inject({
      method: 'PUT',
      url: '/api/provider-plugins/file',
      payload: { path: 'git/notify.ts', content: 'export const plugin = () => {};\n' },
    });
    expect(created.statusCode).toBe(200);
    expect(created.json<{ path: string }>().path).toBe('git/notify.ts');
    // Каталог создан только сейчас — при ЯВНОМ сохранении.
    expect(existsSync(join(pluginsDir, 'git', 'notify.ts'))).toBe(true);

    const list = await app.inject({ method: 'GET', url: '/api/provider-plugins' });
    expect(list.json<ProviderPluginsInfo>().files.map((file) => file.path)).toEqual([
      'git/notify.ts',
    ]);

    const read = await app.inject({
      method: 'GET',
      url: '/api/provider-plugins/file?path=git%2Fnotify.ts',
    });
    expect(read.statusCode).toBe(200);
    expect(read.json<{ content: string }>().content).toBe('export const plugin = () => {};\n');

    const removed = await app.inject({
      method: 'DELETE',
      url: '/api/provider-plugins/file?path=git%2Fnotify.ts',
    });
    expect(removed.statusCode).toBe(200);
    expect(existsSync(join(pluginsDir, 'git', 'notify.ts'))).toBe(false);
  });

  it('опасный путь → 400 unsafe_path (никогда 404) на чтении, записи и удалении', async () => {
    await boot('opencode');
    // Файл ЗА пределами каталога — существует, но панель о нём не сообщит.
    writeFileSync(join(xdgRoot, 'outside.ts'), 'secret');

    for (const path of ['../outside.ts', '/etc/evil.ts', 'C:\\evil.ts', 'note.md', '..']) {
      const encoded = encodeURIComponent(path);

      const read = await app.inject({
        method: 'GET',
        url: `/api/provider-plugins/file?path=${encoded}`,
      });
      expect(read.statusCode, `GET ${path}`).toBe(400);
      expect(read.json<{ error: string }>().error).toBe('unsafe_path');

      const write = await app.inject({
        method: 'PUT',
        url: '/api/provider-plugins/file',
        payload: { path, content: 'x' },
      });
      expect(write.statusCode, `PUT ${path}`).toBe(400);
      expect(write.json<{ error: string }>().error).toBe('unsafe_path');

      const remove = await app.inject({
        method: 'DELETE',
        url: `/api/provider-plugins/file?path=${encoded}`,
      });
      expect(remove.statusCode, `DELETE ${path}`).toBe(400);
      expect(remove.json<{ error: string }>().error).toBe('unsafe_path');
    }

    // Чужой файл цел, каталога плагинов так и нет.
    expect(readFileSync(join(xdgRoot, 'outside.ts'), 'utf8')).toBe('secret');
    expect(existsSync(pluginsDir)).toBe(false);
  });

  it('npm-список: правка сохраняет чужие ключи, битый конфиг → readOnly + 422', async () => {
    writeFileSync(
      configFile,
      JSON.stringify({ model: 'x', permission: { edit: 'deny' }, plugin: ['old'] }, null, 2),
    );
    await boot('opencode');

    const put = await app.inject({
      method: 'PUT',
      url: '/api/provider-plugins/packages',
      payload: { packages: ['opencode-wakatime', '@org/p'] },
    });
    expect(put.statusCode).toBe(200);

    const written = JSON.parse(readFileSync(configFile, 'utf8')) as Record<string, unknown>;
    expect(written.model).toBe('x');
    expect(written.permission).toEqual({ edit: 'deny' });
    expect(written.plugin).toEqual(['opencode-wakatime', '@org/p']);

    // Кривой черновик — 400, файл не тронут.
    const bad = await app.inject({
      method: 'PUT',
      url: '/api/provider-plugins/packages',
      payload: { packages: ['with space'] },
    });
    expect(bad.statusCode).toBe(400);
    expect(bad.json<{ error: string }>().error).toBe('invalid_draft');

    // Битый конфиг: список только для чтения, запись 422, файл байт-в-байт.
    const broken = '{ "plugin": ';
    writeFileSync(configFile, broken);
    const get = await app.inject({ method: 'GET', url: '/api/provider-plugins' });
    expect(get.json<ProviderPluginsInfo>().packagesReadOnly).toBe(true);

    const reject = await app.inject({
      method: 'PUT',
      url: '/api/provider-plugins/packages',
      payload: { packages: ['a'] },
    });
    expect(reject.statusCode).toBe(422);
    expect(reject.json<{ error: string }>().error).toBe('format_unrecognized');
    expect(readFileSync(configFile, 'utf8')).toBe(broken);
  });

  it('файла нет → 404 not_found (в отличие от небезопасного пути)', async () => {
    await boot('opencode');
    const res = await app.inject({
      method: 'GET',
      url: '/api/provider-plugins/file?path=missing.ts',
    });
    expect(res.statusCode).toBe(404);
    expect(res.json<{ error: string }>().error).toBe('not_found');
  });
});
