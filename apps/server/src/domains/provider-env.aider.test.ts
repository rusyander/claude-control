import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { getProvider } from '../providers/registry.ts';
import {
  readProviderEnvVars,
  saveProviderEnvVars,
  UnrecognizedFormatError,
  EnvKeyNotEncodableError,
  type ProviderEnvTarget,
} from './provider-env.ts';

/**
 * Раздел переменных окружения Aider: задокументированный ключ `set-env` в
 * глобальном `~/.aider.conf.yml`.
 *
 * Проверяем ровно то, что обещано: round-trip с сохранением комментариев и
 * прочих ключей, бэкап под ИМЕНЕМ ПРОВАЙДЕРА (`aider-.aider.conf.yml.*`),
 * атомарность (никаких хвостов `.tmp-`), сохранение формы файла (CRLF/BOM) и
 * fail-closed на битом YAML — файл в этом случае не меняется вовсе.
 */

/** Реалистичный конфиг Aider с комментариями и живыми ключами. */
const CONFIG = `## Модель для основного чата
model: gpt-4o

## Set an environment variable
set-env:
  - OPENAI_API_TYPE=azure

## Файлы-конвенции
read:
  - CONVENTIONS.md
`;

describe('Aider env: ~/.aider.conf.yml, ключ set-env', () => {
  let root: string;
  let backupDir: string;
  let filePath: string;

  const target = (): ProviderEnvTarget => ({
    provider: getProvider('aider'),
    format: 'aider-yaml',
    filePath,
    cliDetected: false,
  });

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'cc-aider-env-'));
    backupDir = join(root, 'backups');
    filePath = join(root, '.aider.conf.yml');
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it('читает set-env как пары, отсортированные по ключу', () => {
    writeFileSync(filePath, CONFIG);
    expect(readProviderEnvVars(target())).toEqual([{ key: 'OPENAI_API_TYPE', value: 'azure' }]);
  });

  it('нет файла / пустой файл → пустой список без ошибки', () => {
    expect(readProviderEnvVars(target())).toEqual([]);
    writeFileSync(filePath, '   \n');
    expect(readProviderEnvVars(target())).toEqual([]);
  });

  it('запись сохраняет комментарии и прочие ключи (round-trip)', () => {
    writeFileSync(filePath, CONFIG);
    saveProviderEnvVars(
      target(),
      [
        { key: 'OPENAI_API_TYPE', value: 'azure' },
        { key: 'AIDER_VOICE_LANGUAGE', value: 'ru' },
      ],
      backupDir,
    );

    const text = readFileSync(filePath, 'utf8');
    expect(text).toContain('## Модель для основного чата');
    expect(text).toContain('## Set an environment variable');
    expect(text).toContain('## Файлы-конвенции');
    expect(text).toContain('model: gpt-4o');
    expect(text).toContain('CONVENTIONS.md');

    expect(readProviderEnvVars(target())).toEqual([
      { key: 'AIDER_VOICE_LANGUAGE', value: 'ru' },
      { key: 'OPENAI_API_TYPE', value: 'azure' },
    ]);
  });

  it('копия называется aider-.aider.conf.yml.* — не смешивается с файлами Claude', () => {
    writeFileSync(filePath, CONFIG);
    const backupPath = saveProviderEnvVars(target(), [{ key: 'CI', value: '1' }], backupDir);

    expect(backupPath).toBeDefined();
    const copies = readdirSync(backupDir);
    expect(copies.every((name) => name.startsWith('aider-.aider.conf.yml.'))).toBe(true);
    // Содержимое копии — состояние ДО правки.
    expect(readFileSync(backupPath!, 'utf8')).toBe(CONFIG);
  });

  it('запись атомарна: временных файлов не остаётся', () => {
    writeFileSync(filePath, CONFIG);
    saveProviderEnvVars(target(), [{ key: 'CI', value: '1' }], backupDir);
    expect(readdirSync(root).some((name) => name.includes('.tmp-'))).toBe(false);
  });

  it('CRLF и BOM исходного файла сохраняются', () => {
    writeFileSync(filePath, `\uFEFF${CONFIG.replace(/\n/g, '\r\n')}`);
    saveProviderEnvVars(target(), [{ key: 'CI', value: '1' }], backupDir);

    const raw = readFileSync(filePath, 'utf8');
    expect(raw.startsWith('\uFEFF')).toBe(true);
    // Ни одного «голого» LF: файл остался чистым CRLF.
    expect(/(?<!\r)\n/.test(raw)).toBe(false);
    expect(readProviderEnvVars(target())).toEqual([{ key: 'CI', value: '1' }]);
  });

  it('нет файла → создаётся с одним set-env', () => {
    saveProviderEnvVars(target(), [{ key: 'CI', value: '1' }], backupDir);
    expect(existsSync(filePath)).toBe(true);
    expect(readProviderEnvVars(target())).toEqual([{ key: 'CI', value: '1' }]);
  });

  it('пустой набор удаляет ключ, остальной конфиг цел', () => {
    writeFileSync(filePath, CONFIG);
    saveProviderEnvVars(target(), [], backupDir);

    const text = readFileSync(filePath, 'utf8');
    expect(readProviderEnvVars(target())).toEqual([]);
    expect(text).toContain('model: gpt-4o');
    expect(text).toContain('## Файлы-конвенции');
  });

  it('FAIL-CLOSED: битый YAML — чтение и запись отказывают, файл не тронут', () => {
    const BROKEN = 'model: [не закрыт\n';
    writeFileSync(filePath, BROKEN);

    expect(() => readProviderEnvVars(target())).toThrow(UnrecognizedFormatError);
    expect(() => saveProviderEnvVars(target(), [{ key: 'CI', value: '1' }], backupDir)).toThrow(
      UnrecognizedFormatError,
    );
    expect(readFileSync(filePath, 'utf8')).toBe(BROKEN);
    // Копию тоже не делали: до записи дело не дошло.
    expect(existsSync(backupDir)).toBe(false);
  });

  it('FAIL-CLOSED: set-env неожиданной формы (карта) — не пишем', () => {
    const ODD = 'set-env:\n  CI: 1\n';
    writeFileSync(filePath, ODD);
    expect(() => saveProviderEnvVars(target(), [{ key: 'X', value: '1' }], backupDir)).toThrow(
      UnrecognizedFormatError,
    );
    expect(readFileSync(filePath, 'utf8')).toBe(ODD);
  });

  it('ключ со знаком «=» отклоняется, файл не тронут', () => {
    writeFileSync(filePath, CONFIG);
    expect(() => saveProviderEnvVars(target(), [{ key: 'A=B', value: '1' }], backupDir)).toThrow(
      EnvKeyNotEncodableError,
    );
    expect(readFileSync(filePath, 'utf8')).toBe(CONFIG);
  });
});
