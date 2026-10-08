import { describe, it, expect, beforeEach } from 'vitest';
import type { EnvItem, EnvNeeds } from '@agentdeck/contracts/portable-env';
import { sharedNeeds } from './passport-view';
import { readRememberedTarget } from './target-memory';
import { TRANSFER_TARGET_KEY } from './target-memory.constants';
import { rememberTarget } from './rememberTarget';

// Тест смотрит только на `needs`: остальные поля записи функции не нужны.
const item = (needs: EnvNeeds): EnvItem => ({ needs }) as unknown as EnvItem;
const none = (why: string): EnvNeeds => ({ resolution: 'none', why });
const facts = (...list: string[]): EnvNeeds =>
  ({ resolution: 'facts', facts: list, evidence: {} }) as unknown as EnvNeeds;

describe('sharedNeeds', () => {
  it('возвращает строку, общую для всех записей вида', () => {
    const line = none('фактов рантайма ему не нужно');
    expect(sharedNeeds([item(line), item(none('фактов рантайма ему не нужно'))])).toEqual(line);
  });

  it('одно несовпадение — общей строки нет, каждая запись несёт свою', () => {
    expect(sharedNeeds([item(none('а')), item(none('а')), item(none('б'))])).toBeNull();
  });

  it('«ничего не нужно» и «не определено» с той же фразой — разные требования', () => {
    expect(
      sharedNeeds([item(none('x')), item({ resolution: 'undetermined', why: 'x' })]),
    ).toBeNull();
  });

  it('набор фактов сравнивается без учёта порядка', () => {
    expect(
      sharedNeeds([item(facts('tool_name', 'cwd')), item(facts('cwd', 'tool_name'))]),
    ).not.toBeNull();
    expect(sharedNeeds([item(facts('tool_name')), item(facts('tool_name', 'cwd'))])).toBeNull();
  });

  it('одной записи и пустому виду выносить нечего', () => {
    expect(sharedNeeds([item(none('x'))])).toBeNull();
    expect(sharedNeeds([])).toBeNull();
  });
});

describe('память цели переноса', () => {
  let map: Map<string, string>;
  beforeEach(() => {
    map = new Map();
    (globalThis as unknown as { localStorage: unknown }).localStorage = {
      getItem: (key: string): string | null => map.get(key) ?? null,
      setItem: (key: string, value: string): void => void map.set(key, value),
      removeItem: (key: string): void => void map.delete(key),
    };
  });

  it('выбранная цель вспоминается', () => {
    expect(readRememberedTarget()).toBe('');
    rememberTarget('codex');
    expect(readRememberedTarget()).toBe('codex');
  });

  it('«не выбрана» стирает запись', () => {
    rememberTarget('codex');
    rememberTarget('');
    expect(map.has(TRANSFER_TARGET_KEY)).toBe(false);
  });

  it('недоступное хранилище — не ошибка', () => {
    (globalThis as unknown as { localStorage: unknown }).localStorage = {
      getItem: () => {
        throw new Error('blocked');
      },
      setItem: () => {
        throw new Error('blocked');
      },
    };
    expect(readRememberedTarget()).toBe('');
    expect(() => rememberTarget('codex')).not.toThrow();
  });
});
