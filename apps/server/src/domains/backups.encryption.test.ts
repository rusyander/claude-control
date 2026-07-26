import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { listBackups, restoreBackup } from './backups.ts';
import { encryptSecret } from '../lib/secret-crypto.ts';
import {
  setEncryptSecretBackups,
  setSecretsBasename,
  setSecretPassphrase,
} from '../lib/safe-io.ts';

/**
 * Восстановление ЗАШИФРОВАННОЙ копии файла секретов.
 *
 * Проверяем: зашифрованная копия помечается в списке (interfacе спросит фразу),
 * верная фраза расшифровывает и кладёт исходный текст в файл, неверная —
 * внятный отказ без записи, а копия «состояния до» тоже уходит зашифрованной.
 */
describe('Резервные копии: восстановление зашифрованной копии секретов', () => {
  let dir: string;
  let backupDir: string;
  let secretsPath: string;
  let knownPaths: Record<string, string>;
  const SECRET_NAME = '.mcp-secrets.env';
  const BACKUP_NAME = '.mcp-secrets.env.2026-07-19T10-00-00-000Z.bak';
  const OLD_SECRET = 'TOKEN=старый-секрет\n';
  const CURRENT_SECRET = 'TOKEN=текущий-секрет\n';
  const PASS = 'фраза-для-восстановления';

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'cc-backups-enc-'));
    backupDir = join(dir, 'backups');
    secretsPath = join(dir, SECRET_NAME);
    mkdirSync(backupDir, { recursive: true });

    // Текущий файл секретов и зашифрованная копия его прежнего состояния.
    writeFileSync(secretsPath, CURRENT_SECRET);
    writeFileSync(join(backupDir, BACKUP_NAME), encryptSecret(OLD_SECRET, PASS));

    knownPaths = { secretsEnv: secretsPath };
    // Режим шифрования включён: копия «состояния до» тоже должна зашифроваться.
    setSecretsBasename(SECRET_NAME);
    setEncryptSecretBackups(true);
    setSecretPassphrase(undefined);
  });

  afterEach(() => {
    setEncryptSecretBackups(false);
    setSecretPassphrase(undefined);
    rmSync(dir, { recursive: true, force: true });
  });

  it('зашифрованная копия помечена флагом encrypted', () => {
    const entry = listBackups(backupDir, knownPaths).find((item) => item.name === BACKUP_NAME);
    expect(entry).toBeDefined();
    expect(entry!.encrypted).toBe(true);
    expect(entry!.canRestore).toBe(true);
  });

  it('без фразы восстановление отклоняется, файл не тронут', () => {
    const result = restoreBackup(backupDir, BACKUP_NAME, knownPaths, undefined, undefined);
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/фраза/i);
    expect(readFileSync(secretsPath, 'utf8')).toBe(CURRENT_SECRET);
  });

  it('неверная фраза — внятный отказ, файл не тронут', () => {
    const result = restoreBackup(backupDir, BACKUP_NAME, knownPaths, undefined, 'не-та-фраза');
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/Неверная парольная фраза/);
    expect(readFileSync(secretsPath, 'utf8')).toBe(CURRENT_SECRET);
  });

  it('верная фраза — расшифрованный секрет попадает в файл', () => {
    const result = restoreBackup(backupDir, BACKUP_NAME, knownPaths, undefined, PASS);
    expect(result.ok).toBe(true);
    expect(readFileSync(secretsPath, 'utf8')).toBe(OLD_SECRET);
  });

  it('копия «состояния до» отката тоже зашифрована (текущий секрет не утёк открытым текстом)', () => {
    const result = restoreBackup(backupDir, BACKUP_NAME, knownPaths, undefined, PASS);
    expect(result.ok).toBe(true);
    expect(result.backupPath).toBeDefined();
    const blob = readFileSync(result.backupPath!);
    // Копия текущего состояния не должна лежать открытым текстом.
    expect(blob.toString('utf8')).not.toContain('текущий-секрет');
  });
  it('откат СТАРОЙ незашифрованной копии без фразы отклоняется, токены целы (#67)', () => {
    // Копия из времён до включения шифрования — обычный текст, расшифровывать
    // нечего, поэтому фраза у пользователя и не спрашивается. Раньше копия
    // «состояния до» в этом состоянии просто не делалась (backupEntry молча
    // возвращал undefined), маршрут отвечал ok, и текущие токены исчезали
    // безвозвратно.
    const plainName = '.mcp-secrets.env.2026-07-20T10-00-00-000Z.bak';
    writeFileSync(join(backupDir, plainName), OLD_SECRET);

    const result = restoreBackup(backupDir, plainName, knownPaths, undefined, undefined);

    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/парольная фраза/i);
    expect(readFileSync(secretsPath, 'utf8')).toBe(CURRENT_SECRET);
  });

  it('с фразой в памяти тот же откат проходит и оставляет зашифрованную копию (#67)', () => {
    const plainName = '.mcp-secrets.env.2026-07-20T10-00-00-000Z.bak';
    writeFileSync(join(backupDir, plainName), OLD_SECRET);
    setSecretPassphrase(PASS);

    const result = restoreBackup(backupDir, plainName, knownPaths, undefined, undefined);

    expect(result.ok).toBe(true);
    expect(readFileSync(secretsPath, 'utf8')).toBe(OLD_SECRET);
    expect(result.backupPath).toBeDefined();
    expect(readFileSync(result.backupPath!).toString('utf8')).not.toContain('текущий-секрет');
  });
});
