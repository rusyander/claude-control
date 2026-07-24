import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  readKeyStore,
  getStoredKey,
  hasStoredKey,
  setStoredKey,
  clearStoredKey,
  maskKey,
} from './provider-keys.ts';

/**
 * Хранилище API-ключей провайдеров. Проверяем главное свойство безопасности:
 * ключ на диске лежит ТОЛЬКО зашифрованно (файл не содержит открытого ключа),
 * читается расшифровкой, приоритет/удаление работают, маска не раскрывает ключ.
 */
describe('lib/provider-keys: зашифрованное хранилище', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'cc-keys-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const SECRET = 'sk-test-SUPERSECRET-abcd1234';

  it('нет файла → пустое хранилище', () => {
    expect(readKeyStore(dir)).toEqual({});
    expect(getStoredKey(dir, 'codex')).toBeUndefined();
    expect(hasStoredKey(dir, 'codex')).toBe(false);
  });

  it('сохранение шифрует: файл на диске НЕ содержит открытого ключа', () => {
    setStoredKey(dir, 'codex', SECRET);

    const encPath = join(dir, 'provider-keys.enc');
    expect(existsSync(encPath)).toBe(true);

    // Главная проверка: открытого ключа в файле нет ни в каком виде.
    const raw = readFileSync(encPath);
    expect(raw.includes(Buffer.from(SECRET))).toBe(false);
    expect(raw.toString('utf8')).not.toContain(SECRET);
    expect(raw.toString('latin1')).not.toContain(SECRET);

    // Ключевой файл существует и не равен открытому ключу.
    const keyPath = join(dir, 'provider-keys.key');
    expect(existsSync(keyPath)).toBe(true);
    expect(readFileSync(keyPath, 'utf8')).not.toContain(SECRET);
  });

  it('чтение расшифровывает сохранённое значение', () => {
    setStoredKey(dir, 'codex', SECRET);
    expect(getStoredKey(dir, 'codex')).toBe(SECRET);
    expect(hasStoredKey(dir, 'codex')).toBe(true);
  });

  it('несколько провайдеров хранятся независимо', () => {
    setStoredKey(dir, 'codex', 'sk-codex-1111');
    setStoredKey(dir, 'gemini', 'gm-gemini-2222');
    expect(getStoredKey(dir, 'codex')).toBe('sk-codex-1111');
    expect(getStoredKey(dir, 'gemini')).toBe('gm-gemini-2222');
  });

  it('DELETE очищает только свой ключ', () => {
    setStoredKey(dir, 'codex', 'sk-codex-1111');
    setStoredKey(dir, 'gemini', 'gm-gemini-2222');
    clearStoredKey(dir, 'codex');
    expect(getStoredKey(dir, 'codex')).toBeUndefined();
    expect(getStoredKey(dir, 'gemini')).toBe('gm-gemini-2222');
  });

  it('пустое значение = удаление', () => {
    setStoredKey(dir, 'codex', SECRET);
    setStoredKey(dir, 'codex', '   ');
    expect(getStoredKey(dir, 'codex')).toBeUndefined();
  });

  it('значение обрезается по краям', () => {
    setStoredKey(dir, 'codex', `  ${SECRET}  `);
    expect(getStoredKey(dir, 'codex')).toBe(SECRET);
  });

  it('повреждённый .enc → пустое хранилище (fail-closed, без падения)', () => {
    setStoredKey(dir, 'codex', SECRET);
    // Портим ключевой файл — расшифровка не сойдётся.
    setStoredKey(dir, 'gemini', 'x'); // гарантируем существование
    rmSync(join(dir, 'provider-keys.key'));
    // Новый ключевой файл сгенерируется, старый .enc им не расшифруется.
    expect(readKeyStore(dir)).toEqual({});
  });
});

describe('lib/provider-keys: маскирование', () => {
  it('длинный ключ → префикс + … + последние 4', () => {
    expect(maskKey('sk-1234567890abcd')).toBe('sk-…abcd');
  });
  it('короткий ключ маскируется сильнее', () => {
    expect(maskKey('abcd')).toBe('…cd');
  });
  it('пустой → пусто', () => {
    expect(maskKey('   ')).toBe('');
  });
  it('маска НЕ содержит середины ключа', () => {
    const key = 'sk-SECRETMIDDLE-9999';
    expect(maskKey(key)).not.toContain('SECRETMIDDLE');
  });
});
