import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  backupEntry,
  setEncryptSecretBackups,
  setSecretsBasename,
  setSecretPassphrase,
  hasSecretPassphrase,
} from './safe-io.ts';
import { isEncryptedBackup, decryptSecret } from './secret-crypto.ts';

/**
 * Шифрование резервных копий файла секретов на уровне safe-io/backupEntry.
 *
 * Ключевые гарантии: при выключенном шифровании поведение прежнее (копия —
 * открытый текст); при включённом и введённой фразе копия секретов пишется
 * зашифрованной и расшифровывается обратно; при включённом БЕЗ фразы копия
 * секретов не создаётся вовсе (плейнтекст на диск не утекает); прочие файлы
 * не шифруются никогда.
 */
describe('safe-io: шифрование копий секретов', () => {
  let dir: string;
  let backupDir: string;
  const SECRET_NAME = '.mcp-secrets.env';
  const SECRET_BODY = 'TOKEN=секрет-123\n';
  const PASS = 'парольная-фраза-1';

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'cc-secbackup-'));
    backupDir = join(dir, 'backups');
    setSecretsBasename(SECRET_NAME);
  });

  afterEach(() => {
    // Сбрасываем модульное состояние, чтобы тесты не влияли друг на друга.
    setEncryptSecretBackups(false);
    setSecretPassphrase(undefined);
    rmSync(dir, { recursive: true, force: true });
  });

  const writeSecret = (): string => {
    const path = join(dir, SECRET_NAME);
    writeFileSync(path, SECRET_BODY);
    return path;
  };

  const onlyBak = (): string => readdirSync(backupDir).filter((name) => name.endsWith('.bak'))[0]!;

  it('шифрование выключено — копия секретов остаётся открытым текстом (поведение прежнее)', () => {
    setEncryptSecretBackups(false);
    const path = writeSecret();

    const target = backupEntry(path, backupDir);
    expect(target).toBeDefined();
    expect(readFileSync(target!, 'utf8')).toBe(SECRET_BODY);
    expect(isEncryptedBackup(readFileSync(target!))).toBe(false);
  });

  it('шифрование включено + фраза — копия секретов зашифрована и расшифровывается обратно', () => {
    setEncryptSecretBackups(true);
    setSecretPassphrase(PASS);
    expect(hasSecretPassphrase()).toBe(true);
    const path = writeSecret();

    const target = backupEntry(path, backupDir);
    expect(target).toBeDefined();
    const blob = readFileSync(target!);
    expect(isEncryptedBackup(blob)).toBe(true);
    expect(blob.toString('utf8')).not.toContain('секрет-123');
    expect(decryptSecret(blob, PASS)).toBe(SECRET_BODY);
  });

  it('шифрование включено, но фразы нет — копия секретов НЕ создаётся (плейнтекст не утекает)', () => {
    setEncryptSecretBackups(true);
    setSecretPassphrase(undefined);
    const path = writeSecret();

    const target = backupEntry(path, backupDir);
    expect(target).toBeUndefined();
    // В каталоге копий не появилось ни одного .bak.
    const baks = readdirSync(backupDir).filter((name) => name.endsWith('.bak'));
    expect(baks).toHaveLength(0);
  });

  it('обычные файлы не шифруются даже при включённом шифровании', () => {
    setEncryptSecretBackups(true);
    setSecretPassphrase(PASS);
    const path = join(dir, 'settings.json');
    writeFileSync(path, '{"a":1}');

    const target = backupEntry(path, backupDir);
    expect(target).toBeDefined();
    expect(readFileSync(target!, 'utf8')).toBe('{"a":1}');
    expect(isEncryptedBackup(readFileSync(target!))).toBe(false);
    // и что это именно наш единственный бэкап
    expect(onlyBak()).toContain('settings.json');
  });
});
