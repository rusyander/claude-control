import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it, expect } from 'vitest';
import { ru } from '@shared/config/i18n/ru';
import { en } from '@shared/config/i18n/en';

/**
 * Регрессия: панель звала `t('providerSkills.deleteSkill')`, а такого ключа в
 * словаре не было — i18next возвращает сам ключ, и в подтверждении удаления
 * вместо предупреждения стояла строка «providerSkills.deleteSkill». `tsc`
 * такое не ловит: он сверяет полноту словарей между собой, но не места вызова.
 *
 * Поэтому проверяем сами вызовы: каждый литеральный ключ из исходников раздела
 * обязан существовать в обоих словарях. Шаблонные ключи (`badge.${…}`) сюда не
 * попадают — их собирают в рантайме.
 */

const pageDir = import.meta.dirname;

const lookup = (dictionary: unknown, key: string): unknown =>
  key.split('.').reduce<unknown>((node, part) => {
    if (typeof node !== 'object' || node === null) return undefined;
    return (node as Record<string, unknown>)[part];
  }, dictionary);

const usedKeys = (): string[] => {
  const keys = new Set<string>();

  for (const file of readdirSync(pageDir)) {
    if (!file.endsWith('.tsx') && !file.endsWith('.ts')) continue;
    if (file.endsWith('.test.ts') || file.endsWith('.test.tsx')) continue;

    const source = readFileSync(join(pageDir, file), 'utf8');
    for (const match of source.matchAll(/\bt\(\s*'([\w.]+)'/g)) {
      if (match[1]) keys.add(match[1]);
    }
  }

  return [...keys].sort();
};

describe('ключи перевода раздела скиллов провайдера', () => {
  it('в исходниках раздела вообще есть вызовы перевода', () => {
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

  it('панель зовёт именно providerSkills.deleteSkill — имя вызова и ключа совпадают', () => {
    expect(usedKeys()).toContain('providerSkills.deleteSkill');
  });

  it('текст подтверждения удаления объясняет, что уносит папку целиком', () => {
    expect(ru.providerSkills.deleteSkill).toContain('папк');
    expect(en.providerSkills.deleteSkill).toContain('folder');
  });
});
