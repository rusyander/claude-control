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

  it('opencode: уже записанные хуки читаются целиком, чужие ключи видны', async () => {
    // Ключ снят с записи (см. ниже), но ЧТЕНИЕ обязано работать полностью: у
    // человека хуки могли остаться от прежних версий, и прятать их нельзя.
    writeFileSync(
      configFile,
      JSON.stringify(
        {
          $schema: 'https://opencode.ai/config.json',
          model: 'anthropic/claude-sonnet-4',
          permission: { edit: 'deny' },
          experimental: {
            policies: [{ effect: 'deny' }],
            hook: {
              file_edited: {
                '*.ts': [{ command: ['prettier', '--write'], environment: { NODE_ENV: 'dev' } }],
              },
              session_completed: [{ command: ['notify-send', 'done'] }],
            },
          },
        },
        null,
        2,
      ),
    );

    await boot('opencode');

    const response = await app.inject({ method: 'GET', url: '/api/provider-hooks' });
    expect(response.statusCode).toBe(200);
    const info = response.json<ProviderHooksInfo>();
    expect(info.providerId).toBe('opencode');
    expect(info.filePath).toBe(configFile);
    expect(info.present).toBe(true);
    expect(info.fileEdited).toEqual([
      {
        pattern: '*.ts',
        actions: [
          { command: ['prettier', '--write'], environment: [{ key: 'NODE_ENV', value: 'dev' }] },
        ],
      },
    ]);
    expect(info.sessionCompleted).toEqual([{ command: ['notify-send', 'done'] }]);
    expect(info.preservedExperimental.map((entry) => entry.key)).toEqual(['policies']);
  });

  it('запись запрещена: 409 write_disabled с причиной, файл байт-в-байт', async () => {
    // `experimental.hook` исчез из справочника конфигурации OpenCode и из
    // опубликованной схемы (2026-07-25) — панель перестала его писать. Это НЕ
    // ошибка формата: файл в полном порядке, поэтому 409, а не 422.
    const before = JSON.stringify({ model: 'anthropic/claude-sonnet-4' }, null, 2);
    writeFileSync(configFile, before);
    await boot('opencode');

    const get = await app.inject({ method: 'GET', url: '/api/provider-hooks' });
    const info = get.json<ProviderHooksInfo>();
    expect(info.readOnly).toBe(true);
    expect(info.writeDisabledReason).toContain('experimental.hook');
    // Причина — не поломка файла, `error` обязан остаться пустым.
    expect(info.error).toBeUndefined();

    const put = await app.inject({
      method: 'PUT',
      url: '/api/provider-hooks',
      payload: { fileEdited: [], sessionCompleted: [{ command: ['notify-send', 'done'] }] },
    });
    expect(put.statusCode).toBe(409);
    expect(put.json<{ error: string }>().error).toBe('write_disabled');
    expect(readFileSync(configFile, 'utf8')).toBe(before);
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

  it('битый JSON: GET отдаёт readOnly и ошибку файла, файл байт-в-байт', async () => {
    const before = '{ "experimental": ';
    writeFileSync(configFile, before);
    await boot('opencode');

    const get = await app.inject({ method: 'GET', url: '/api/provider-hooks' });
    expect(get.statusCode).toBe(200);
    const info = get.json<ProviderHooksInfo>();
    expect(info.readOnly).toBe(true);
    // Здесь причин две сразу: ключ снят с записи И файл не разобран. Обе честно
    // видны, одна другую не подменяет.
    expect(info.error).toBeTruthy();
    expect(info.writeDisabledReason).toBeTruthy();

    const put = await app.inject({
      method: 'PUT',
      url: '/api/provider-hooks',
      payload: { fileEdited: [], sessionCompleted: [{ command: ['x'] }] },
    });
    // Отказ по снятому ключу срабатывает ДО чтения файла — 409 (422 на непонятом
    // файле по-прежнему проверен в тестах домена, где ключ не заперт).
    expect(put.statusCode).toBe(409);
    expect(readFileSync(configFile, 'utf8')).toBe(before);
  });
});
