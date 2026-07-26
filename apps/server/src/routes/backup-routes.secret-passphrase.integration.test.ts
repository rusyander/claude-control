import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { tmpdir } from 'node:os';
import { AppStore } from '../lib/app-store.ts';
import type { ServerContext } from '../context.ts';
import { registerBackupRoutes } from './backup-routes.ts';
import {
  backupEntry,
  setBackupKeep,
  setEncryptSecretBackups,
  setSecretPassphrase,
  setSecretsBasename,
} from '../lib/safe-io.ts';
import { isEncryptedBackup } from '../lib/secret-crypto.ts';

/**
 * Включение шифрования копий секретов из панели.
 *
 * Ловушка: настройка ложилась в state.json, а шифрование живёт глобальным
 * флагом в safe-io — тот оставался выключенным до перезапуска. Панель при этом
 * рапортовала «шифрование включено», а копии `.mcp-secrets.env` продолжали
 * ложиться открытым текстом рядом с токенами. Проверяем не флаг, а результат:
 * следующая копия секретов обязана быть зашифрованной.
 */
describe('backup-routes: включение шифрования копий секретов действует сразу', () => {
  let root: string;
  let app: FastifyInstance;
  let secretsPath: string;
  let backupDir: string;
  const PASS = 'достаточно-длинная-фраза';
  const SECRET = 'TOKEN=живой-секрет\n';

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), 'cc-backup-routes-'));
    mkdirSync(join(root, 'claude-control'), { recursive: true });
    secretsPath = join(root, '.mcp-secrets.env');
    backupDir = join(root, 'claude-control', 'backups');

    const store = new AppStore(join(root, 'claude-control'));
    const location = {
      paths: {
        root,
        settings: join(root, 'settings.json'),
        settingsLocal: join(root, 'settings.local.json'),
        claudeMd: join(root, 'CLAUDE.md'),
        skills: join(root, 'skills'),
        mcpConfig: join(root, '.claude.json'),
        secretsEnv: secretsPath,
        appData: join(root, 'claude-control'),
      },
    };

    const ctx = {
      location,
      store,
      // Повторяет ServerContext.applyIoSettings: те же три сеттера safe-io.
      applyIoSettings: () => {
        setBackupKeep(store.getSettings().backupKeep);
        setEncryptSecretBackups(store.getSettings().encryptSecretBackups);
        setSecretsBasename(basename(location.paths.secretsEnv));
      },
    } as unknown as ServerContext;

    // Стартовое состояние процесса: шифрование выключено, фразы в памяти нет.
    setEncryptSecretBackups(false);
    setSecretPassphrase(undefined);
    setSecretsBasename(basename(secretsPath));

    app = Fastify();
    registerBackupRoutes(app, ctx);
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
    setEncryptSecretBackups(false);
    setSecretPassphrase(undefined);
    rmSync(root, { recursive: true, force: true });
  });

  it('после включения копия секретов уходит зашифрованной, а не открытым текстом', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/backups/secret-passphrase',
      payload: { passphrase: PASS, enable: true },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json<{ encryptSecrets: boolean }>().encryptSecrets).toBe(true);

    writeFileSync(secretsPath, SECRET);
    const copy = backupEntry(secretsPath, backupDir);
    expect(copy).toBeDefined();

    const blob = readFileSync(copy!);
    expect(isEncryptedBackup(blob)).toBe(true);
    expect(blob.toString('utf8')).not.toContain('живой-секрет');
  });

  it('короткая фраза отклоняется 400 и режим не включается', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/backups/secret-passphrase',
      payload: { passphrase: 'ко', enable: true },
    });

    expect(res.statusCode).toBe(400);

    writeFileSync(secretsPath, SECRET);
    const copy = backupEntry(secretsPath, backupDir);
    expect(readFileSync(copy!, 'utf8')).toBe(SECRET);
  });
});
