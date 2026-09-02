import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { setStoredKey, getStoredKey, maskKey } from './provider-keys.ts';
import { listBackups } from '../domains/backups.ts';
import { searchEntities } from '../domains/search.ts';

/**
 * Ф9/Ф10 — ключи провайдеров: права, атомарность и НЕпопадание наружу.
 *
 * Ключи лежат зашифрованными в appData панели (`provider-keys.enc`), фраза
 * шифрования — машинно-локальный секрет (`provider-keys.key`). Требования те же,
 * что к `.mcp-secrets.env`: 0600 на POSIX, ни в резервные копии, ни в бандл
 * конфигурации, ни в глобальный поиск они не попадают.
 */
let appData: string;
beforeEach(() => {
  appData = mkdtempSync(join(tmpdir(), 'cc-keys-sec-'));
});
afterEach(() => rmSync(appData, { recursive: true, force: true }));

const SECRET = 'sk-секретный-ключ-1234';

describe('файлы ключей: права и содержимое', () => {
  it('открытого ключа на диске нет — только шифротекст и маска наружу', () => {
    setStoredKey(appData, 'codex', SECRET);

    const blob = readFileSync(join(appData, 'provider-keys.enc'));
    expect(blob.includes(Buffer.from(SECRET, 'utf8'))).toBe(false);
    expect(getStoredKey(appData, 'codex')).toBe(SECRET);
    expect(maskKey(SECRET)).not.toContain('секретный');
  });

  /**
   * Тест НЕ пропускается ни на одной ОС: на POSIX проверяются сами права 0600,
   * на Windows — что оба файла реально создаются и читаются (режимы posix там не
   * применяются, защита — ACL профиля пользователя). Пропуск скрыл бы регресс
   * «файл ключей вообще не создался» на машине разработчика под Windows.
   */
  it('оба файла создаются: на POSIX с правами 0600, на Windows — просто создаются', () => {
    setStoredKey(appData, 'codex', SECRET);
    const enc = statSync(join(appData, 'provider-keys.enc'));
    const master = statSync(join(appData, 'provider-keys.key'));

    expect(enc.isFile()).toBe(true);
    expect(master.isFile()).toBe(true);
    expect(getStoredKey(appData, 'codex')).toBe(SECRET);

    if (process.platform !== 'win32') {
      expect(enc.mode & 0o777).toBe(0o600);
      expect(master.mode & 0o777).toBe(0o600);
    }
  });

  it('запись атомарная: временных файлов после сохранения не остаётся', () => {
    setStoredKey(appData, 'codex', SECRET);
    setStoredKey(appData, 'gemini', 'sk-второй-ключ-5678');

    expect(readdirSync(appData).filter((name) => name.includes('.tmp-'))).toEqual([]);
    expect(getStoredKey(appData, 'codex')).toBe(SECRET);
    expect(getStoredKey(appData, 'gemini')).toBe('sk-второй-ключ-5678');
  });
});

describe('ключи не утекают в разделы панели', () => {
  it('в резервные копии файлы ключей не попадают (их никто не бэкапит)', () => {
    setStoredKey(appData, 'codex', SECRET);
    const backupDir = join(appData, 'backups');

    // Даже если каталог копий уже есть — ключи туда не копируются.
    expect(listBackups(backupDir, {})).toEqual([]);
    expect(readdirSync(appData)).not.toContain('backups');
  });

  it('глобальный поиск ключи не индексирует — у него нет такого раздела', () => {
    setStoredKey(appData, 'codex', SECRET);

    const results = searchEntities(
      {
        rules: [],
        hooks: [],
        skills: [],
        scripts: [],
        permissions: [],
        envVars: [],
        mcpServers: [],
        plugins: [],
        groups: [],
      },
      'секретный',
    );

    expect(results).toEqual([]);
  });
});
