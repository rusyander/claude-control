import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { basename, join } from 'node:path';
import { tmpdir } from 'node:os';
import { AppStore } from '../lib/app-store.ts';
import type { ServerContext } from '../context.ts';
import { registerEntityRoutes } from './entity-routes.ts';
import {
  setEncryptSecretBackups,
  setSecretPassphrase,
  setSecretsBasename,
} from '../lib/safe-io.ts';

/**
 * Правка секрета, когда резервную копию сделать нечем.
 *
 * Шифрование копий включено, а фразы в памяти нет — обычное состояние после
 * перезапуска сервера. Копия обязана не появиться (открытым текстом её писать
 * нельзя), а разрушающая запись — не состояться. Ловушка была в том, КАК это
 * видно снаружи: safe-io бросает, глобального обработчика ошибок нет, и
 * пользователь получал 500 «Internal Server Error» на обычное действие. Ждём
 * внятный 409 с причиной — и нетронутый файл секретов.
 */
describe('маршруты сущностей: правка секрета без возможной копии отвечает 409', () => {
  let root: string;
  let app: FastifyInstance;
  let secretsPath: string;
  let backupDir: string;
  const BEFORE = 'TOKEN=старый-секрет\n';

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), 'cc-env-409-'));
    const appData = join(root, 'claude-control');
    mkdirSync(appData, { recursive: true });
    writeFileSync(join(root, 'settings.json'), '{}\n');
    secretsPath = join(root, '.mcp-secrets.env');
    backupDir = join(appData, 'backups');
    writeFileSync(secretsPath, BEFORE);

    const ctx = {
      location: {
        paths: {
          root,
          appData,
          settings: join(root, 'settings.json'),
          settingsLocal: join(root, 'settings.local.json'),
          claudeMd: join(root, 'CLAUDE.md'),
          skills: join(root, 'skills'),
          hooks: join(root, 'hooks'),
          mcpConfig: join(root, '.claude.json'),
          secretsEnv: secretsPath,
        },
      },
      store: new AppStore(appData),
      backupDir,
    } as unknown as ServerContext;

    // Состояние процесса: копии шифруются, фразы в памяти нет.
    setSecretsBasename(basename(secretsPath));
    setEncryptSecretBackups(true);
    setSecretPassphrase(undefined);

    app = Fastify();
    registerEntityRoutes(app, ctx);
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
    setEncryptSecretBackups(false);
    setSecretPassphrase(undefined);
    rmSync(root, { recursive: true, force: true });
  });

  it('запись секрета: 409 с причиной, файл и копии не тронуты', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/env',
      payload: { key: 'TOKEN', value: 'новый-секрет', source: 'secrets' },
    });

    expect(res.statusCode).toBe(409);
    expect(res.json<{ error: string; message: string }>().error).toBe('secret_backup_unavailable');
    expect(res.json<{ message: string }>().message).toMatch(/парольная фраза/i);

    expect(readFileSync(secretsPath, 'utf8')).toBe(BEFORE);
    expect(existsSync(backupDir)).toBe(false);
  });

  it('удаление секрета: тот же 409, переменная остаётся на месте', async () => {
    const res = await app.inject({
      method: 'DELETE',
      url: '/api/env?key=TOKEN&source=secrets',
    });

    expect(res.statusCode).toBe(409);
    expect(res.json<{ error: string }>().error).toBe('secret_backup_unavailable');
    expect(readFileSync(secretsPath, 'utf8')).toBe(BEFORE);
  });

  it('с введённой фразой та же правка проходит: отказ именно из-за копии', async () => {
    setSecretPassphrase('достаточно-длинная-фраза');

    const res = await app.inject({
      method: 'POST',
      url: '/api/env',
      payload: { key: 'TOKEN', value: 'новый-секрет', source: 'secrets' },
    });

    expect(res.statusCode).toBe(200);
    expect(readFileSync(secretsPath, 'utf8')).toContain('новый-секрет');
  });
});
