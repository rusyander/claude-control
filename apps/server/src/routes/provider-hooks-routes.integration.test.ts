import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { ProviderHooksInfo } from '@claude-control/contracts';
import { AppStore } from '../lib/app-store.ts';
import type { ServerContext } from '../context.ts';
import { registerProviderHooksRoutes } from './provider-hooks-routes.ts';

/**
 * OPENCODE-3, маршруты: `/api/provider-hooks`.
 *
 * Проверяем на ВРЕМЕННОМ HOME (`OPENCODE_CONFIG` переносит сам файл конфига) —
 * реальный `~` не трогается вовсе. Смотрим главное: раздел доступен ТОЛЬКО у
 * opencode (у claude и остальных — 400, потому что модель у них другая или
 * раздела нет), полный цикл чтения/записи, кривой черновик → 400 без записи,
 * битый файл → readOnly на чтении и 422 на записи.
 */
describe('provider-hooks-routes: хуки провайдера ключом конфига', () => {
  let appDataRoot: string;
  let configFile: string;
  let app: FastifyInstance;
  let previousConfig: string | undefined;

  const boot = async (provider: string): Promise<void> => {
    const store = new AppStore(appDataRoot);
    if (provider !== 'claude') store.updateSettings({ provider });

    const ctx = { store, backupDir: join(appDataRoot, 'backups') } as unknown as ServerContext;
    app = Fastify();
    registerProviderHooksRoutes(app, ctx);
    await app.ready();
  };

  beforeEach(() => {
    appDataRoot = mkdtempSync(join(tmpdir(), 'cc-appdata-'));
    const configRoot = mkdtempSync(join(tmpdir(), 'cc-opencode-home-'));
    mkdirSync(join(configRoot, 'opencode'), { recursive: true });
    configFile = join(configRoot, 'opencode', 'opencode.json');
    // Задокументированный перенос САМОГО файла конфигурации — реальный `~`
    // пользователя при этом не читается и не создаётся.
    previousConfig = process.env.OPENCODE_CONFIG;
    process.env.OPENCODE_CONFIG = configFile;
  });

  afterEach(async () => {
    await app?.close();
    if (previousConfig === undefined) delete process.env.OPENCODE_CONFIG;
    else process.env.OPENCODE_CONFIG = previousConfig;
    rmSync(appDataRoot, { recursive: true, force: true });
    rmSync(join(configFile, '..', '..'), { recursive: true, force: true });
  });

  it('раздел доступен только у opencode: у claude и прочих — 400', async () => {
    for (const provider of ['claude', 'codex', 'gemini', 'cursor', 'aider']) {
      await boot(provider);
      const get = await app.inject({ method: 'GET', url: '/api/provider-hooks' });
      expect(get.statusCode, provider).toBe(400);
      expect(get.json<{ error: string }>().error, provider).toBe('section_unsupported');

      const put = await app.inject({
        method: 'PUT',
        url: '/api/provider-hooks',
        payload: { fileEdited: [], sessionCompleted: [{ command: ['x'] }] },
      });
      expect(put.statusCode, provider).toBe(400);
      await app.close();
    }
    // Ни один чужой конфиг при этом не создан.
    expect(existsSync(configFile)).toBe(false);
  });

  it('opencode: полный цикл чтения и записи, чужие ключи файла целы', async () => {
    writeFileSync(
      configFile,
      JSON.stringify(
        {
          $schema: 'https://opencode.ai/config.json',
          model: 'anthropic/claude-sonnet-4',
          permission: { edit: 'deny' },
          experimental: { policies: [{ effect: 'deny' }] },
        },
        null,
        2,
      ),
    );

    await boot('opencode');

    const before = await app.inject({ method: 'GET', url: '/api/provider-hooks' });
    expect(before.statusCode).toBe(200);
    const info = before.json<ProviderHooksInfo>();
    expect(info.providerId).toBe('opencode');
    expect(info.filePath).toBe(configFile);
    expect(info.present).toBe(false);
    expect(info.readOnly).toBe(false);
    expect(info.preservedExperimental.map((entry) => entry.key)).toEqual(['policies']);

    const put = await app.inject({
      method: 'PUT',
      url: '/api/provider-hooks',
      payload: {
        fileEdited: [
          {
            pattern: '*.ts',
            actions: [
              {
                command: ['prettier', '--write'],
                environment: [{ key: 'NODE_ENV', value: 'dev' }],
              },
            ],
          },
        ],
        sessionCompleted: [{ command: ['notify-send', 'done'] }],
      },
    });
    expect(put.statusCode).toBe(200);
    expect(put.json<{ ok: boolean; needsRestart: boolean }>()).toMatchObject({
      ok: true,
      needsRestart: true,
    });

    const written = JSON.parse(readFileSync(configFile, 'utf8')) as Record<string, unknown>;
    expect(written.$schema).toBe('https://opencode.ai/config.json');
    expect(written.model).toBe('anthropic/claude-sonnet-4');
    expect(written.permission).toEqual({ edit: 'deny' });
    expect((written.experimental as Record<string, unknown>).policies).toEqual([
      { effect: 'deny' },
    ]);

    const after = await app.inject({ method: 'GET', url: '/api/provider-hooks' });
    const next = after.json<ProviderHooksInfo>();
    expect(next.present).toBe(true);
    expect(next.fileEdited).toEqual([
      {
        pattern: '*.ts',
        actions: [
          { command: ['prettier', '--write'], environment: [{ key: 'NODE_ENV', value: 'dev' }] },
        ],
      },
    ]);
    expect(next.sessionCompleted).toEqual([{ command: ['notify-send', 'done'] }]);
  });

  it('кривой черновик → 400, файл не тронут', async () => {
    const before = JSON.stringify({ model: 'x' });
    writeFileSync(configFile, before);
    await boot('opencode');

    for (const payload of [
      { fileEdited: [], sessionCompleted: [{ command: 'prettier --write' }] },
      { fileEdited: [], sessionCompleted: [{ command: [] }] },
      { fileEdited: [{ pattern: '', actions: [{ command: ['x'] }] }], sessionCompleted: [] },
      { sessionCompleted: [] },
    ]) {
      const res = await app.inject({ method: 'PUT', url: '/api/provider-hooks', payload });
      expect(res.statusCode, JSON.stringify(payload)).toBe(400);
      expect(res.json<{ error: string }>().error).toBe('invalid_draft');
    }
    expect(readFileSync(configFile, 'utf8')).toBe(before);
  });

  it('битый JSON: GET отдаёт readOnly, PUT 422, файл байт-в-байт', async () => {
    const before = '{ "experimental": ';
    writeFileSync(configFile, before);
    await boot('opencode');

    const get = await app.inject({ method: 'GET', url: '/api/provider-hooks' });
    expect(get.statusCode).toBe(200);
    expect(get.json<ProviderHooksInfo>().readOnly).toBe(true);

    const put = await app.inject({
      method: 'PUT',
      url: '/api/provider-hooks',
      payload: { fileEdited: [], sessionCompleted: [{ command: ['x'] }] },
    });
    expect(put.statusCode).toBe(422);
    expect(put.json<{ error: string }>().error).toBe('format_unrecognized');
    expect(readFileSync(configFile, 'utf8')).toBe(before);
  });
});
