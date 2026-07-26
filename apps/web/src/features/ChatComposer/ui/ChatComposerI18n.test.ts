import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it, expect } from 'vitest';
import { ru } from '@shared/config/i18n/ru';
import { en } from '@shared/config/i18n/en';

/**
 * Регрессия: кнопка микрофона звала `t('assistant.voiceInput')`, а такого ключа
 * в словаре нет — i18next возвращает сам ключ, и доступным именем кнопки
 * («что произносит скринридер») была строка «assistant.voiceInput». `tsc` это
 * не ловит: он сверяет полноту словарей между собой, но не места вызова.
 *
 * Поэтому проверяем сами вызовы: каждый литеральный ключ из исходников
 * композера обязан существовать в обоих словарях. Собранные в рантайме ключи
 * (`t(speechErrorKey)`) сюда не попадают — их покрывает speech-state.test.ts.
 */

const uiDir = import.meta.dirname;

const lookup = (dictionary: unknown, key: string): unknown =>
  key.split('.').reduce<unknown>((node, part) => {
    if (typeof node !== 'object' || node === null) return undefined;
    return (node as Record<string, unknown>)[part];
  }, dictionary);

const usedKeys = (): string[] => {
  const keys = new Set<string>();

  for (const file of readdirSync(uiDir)) {
    if (!file.endsWith('.tsx') && !file.endsWith('.ts')) continue;
    if (file.endsWith('.test.ts') || file.endsWith('.test.tsx')) continue;

    const source = readFileSync(join(uiDir, file), 'utf8');
    for (const match of source.matchAll(/\bt\(\s*'([\w.]+)'/g)) {
      if (match[1]) keys.add(match[1]);
    }
  }

  return [...keys].sort();
};

describe('ключи перевода поля ввода чата', () => {
  it('в исходниках композера вообще есть вызовы перевода', () => {
    expect(usedKeys().length).toBeGreaterThan(5);
  });

  it('каждый вызванный ключ объявлен в русском словаре', () => {
    const missing = usedKeys().filter((key) => typeof lookup(ru, key) !== 'string');
    expect(missing).toEqual([]);
  });

  it('каждый вызванный ключ объявлен в английском словаре', () => {
    const missing = usedKeys().filter((key) => typeof lookup(en, key) !== 'string');
    expect(missing).toEqual([]);
  });

  it('кнопка микрофона зовёт существующий assistant.startVoice', () => {
    expect(usedKeys()).toContain('assistant.startVoice');
    expect(usedKeys()).not.toContain('assistant.voiceInput');
  });
});
