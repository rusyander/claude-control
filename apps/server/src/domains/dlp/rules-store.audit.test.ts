import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DlpRule } from '@claude-control/contracts';
import { AliasVault } from './mask.ts';
import { DlpRulesError, parseRules, readRules, saveRules, validateRules } from './rules-store.ts';

/**
 * Что нашёл аудит раздела: мусор вместо правила ронял сохранение в 500, повтор
 * идентификатора принимался молча, а очистка словаря меток забывала сущности —
 * после перезапуска прокси то же значение получало метку «уже встречалось».
 */

function rule(patch: Partial<DlpRule> & Pick<DlpRule, 'id' | 'name'>): DlpRule {
  return {
    enabled: true,
    kind: 'terms',
    terms: ['Урманов'],
    pattern: '',
    action: 'mask',
    label: 'ИМЯ',
    ...patch,
  };
}

describe('проверка правил до записи', () => {
  it('null и объект без обязательных полей — понятный отказ, не исключение', () => {
    expect(validateRules([null])).toBe('правило №1: не соответствует схеме');
    expect(validateRules([{ id: 'x' }])).toBe('правило №1: не соответствует схеме');
    expect(validateRules([{ name: 'Почта', kind: 'builtin' }])).toBe(
      'правило «Почта»: не соответствует схеме',
    );
    expect(parseRules([42])).toBeInstanceOf(DlpRulesError);
  });

  it('повтор идентификатора отклоняется — карточки правятся и удаляются по id', () => {
    expect(
      validateRules([rule({ id: 'same', name: 'Первое' }), rule({ id: 'same', name: 'Второе' })]),
    ).toBe('правило «Второе»: идентификатор повторяется');
  });

  it('пустой словарь, невыбранный образец и битое выражение называют правило', () => {
    expect(validateRules([rule({ id: 'a', name: 'Словарь', terms: ['  '] })])).toBe(
      'правило «Словарь»: словарь пуст',
    );
    expect(validateRules([rule({ id: 'b', name: 'Образец', kind: 'builtin', terms: [] })])).toBe(
      'правило «Образец»: не выбран встроенный образец',
    );
    expect(
      validateRules([rule({ id: 'c', name: 'Регулярка', kind: 'regex', pattern: '(unclosed' })]),
    ).toBe('правило «Регулярка»: выражение не разбирается');
  });

  it('разбор для предпросмотра пропускает пустой словарь, но не мусор', () => {
    const draft = parseRules([rule({ id: 'd', name: 'Черновик', terms: [] })]);
    expect(Array.isArray(draft)).toBe(true);
    expect((draft as DlpRule[])[0]?.terms).toEqual([]);
    expect(parseRules([rule({ id: 'e', name: 'Ок' }), 'мусор'])).toBeInstanceOf(DlpRulesError);
  });
});

describe('запись правил', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'dlp-rules-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('с мусором в списке файл не трогается, а ошибка называет правило', () => {
    saveRules(dir, [rule({ id: 'ok', name: 'Ок' })]);
    expect(() => saveRules(dir, [rule({ id: 'ok', name: 'Ок' }), null])).toThrow(
      /правило №2: не соответствует схеме/,
    );
    expect(readRules(dir).map((r) => r.id)).toEqual(['ok']);
  });

  it('повтор идентификатора не доходит до диска', () => {
    expect(() =>
      saveRules(dir, [rule({ id: 'dup', name: 'A' }), rule({ id: 'dup', name: 'B' })]),
    ).toThrow(/идентификатор повторяется/);
    expect(readRules(dir)).toEqual([]);
  });
});

describe('словарь меток после очистки', () => {
  it('сущности забываются вместе с номерами — первое значение снова [ИМЯ_1], не [ИМЯ_1.2]', () => {
    const vault = new AliasVault();
    expect(vault.placeholderFor('ИМЯ', 'Урманов', 'урманов')).toBe('[ИМЯ_1]');
    expect(vault.placeholderFor('ИМЯ', 'Урманова', 'урманов')).toBe('[ИМЯ_1.2]');

    vault.clear();

    expect(vault.size).toBe(0);
    expect(vault.placeholderFor('ИМЯ', 'Урманова', 'урманов')).toBe('[ИМЯ_1]');
    expect(vault.placeholderFor('ИМЯ', 'Петров', 'петров')).toBe('[ИМЯ_2]');
  });
});
