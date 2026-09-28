import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  assertRuleTitleFree,
  deleteRule,
  readRules,
  RuleTitleTakenError,
  saveRule,
  setRulesEnabled,
} from './rules.ts';
import { AppStore } from '../lib/app-store.ts';
import * as safeIo from '../lib/safe-io.ts';

/**
 * F2 (решение владельца 27.09): включённое правило возвращается на СВОЁ место
 * в CLAUDE.md, а не в конец. Плюс D-A: занятый заголовок — отказ.
 */
const rule = (title: string, body = `Текст ${title}.`): string => `## ПРАВИЛО: ${title}\n\n${body}`;
const file = (...titles: string[]): string =>
  `${['# Шапка\n\nСвободный абзац.', ...titles.map((title) => rule(title))].join('\n\n')}\n`;

describe('rules: место выключенного правила (F2)', () => {
  let dir: string;
  let claudeMd: string;
  let store: AppStore;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'cc-rules-pos-'));
    claudeMd = join(dir, 'CLAUDE.md');
    mkdirSync(join(dir, 'app'), { recursive: true });
    store = new AppStore(join(dir, 'app'));
  });

  afterEach(() => {
    vi.restoreAllMocks();
    rmSync(dir, { recursive: true, force: true });
  });

  const read = (): string => readFileSync(claudeMd, 'utf8');
  const idOf = (title: string): string => {
    const found = readRules(claudeMd, store).find((item) => item.title === title);
    if (!found) throw new Error(`нет правила ${title}`);
    return found.id;
  };
  /** Как маршрут `/api/entities/rule/:id/enabled`: отметка, затем запись. */
  const toggle = (title: string, isEnabled: boolean): void => {
    const id = idOf(title);
    store.setEnabled('rule', id, isEnabled);
    const current = readRules(claudeMd, store).find((item) => item.id === id)!;
    saveRule(claudeMd, id, { ...current, isEnabled }, store);
  };

  it('правило из середины возвращается в середину', () => {
    writeFileSync(claudeMd, file('A', 'B', 'C'));
    toggle('B', false);
    expect(read()).toBe(file('A', 'C'));
    toggle('B', true);
    expect(read()).toBe(file('A', 'B', 'C'));
  });

  it('первое и последнее возвращаются на края', () => {
    writeFileSync(claudeMd, file('A', 'B', 'C'));
    toggle('A', false);
    toggle('C', false);
    expect(read()).toBe(file('B'));
    toggle('C', true);
    toggle('A', true);
    expect(read()).toBe(file('A', 'B', 'C'));
  });

  it('два соседних выключенных возвращаются в исходном порядке, в любом порядке включения', () => {
    writeFileSync(claudeMd, file('A', 'B', 'C', 'D'));
    toggle('B', false);
    toggle('C', false);
    expect(read()).toBe(file('A', 'D'));
    // Сначала C: его сосед B ещё выключен — место C всё равно «после B».
    toggle('C', true);
    expect(read()).toBe(file('A', 'C', 'D'));
    toggle('B', true);
    expect(read()).toBe(file('A', 'B', 'C', 'D'));
  });

  it('сосед удалён — правило встаёт перед вторым соседом', () => {
    writeFileSync(claudeMd, file('A', 'B', 'C'));
    toggle('B', false);
    deleteRule(claudeMd, idOf('A'), store);
    toggle('B', true);
    expect(read()).toBe(file('B', 'C'));
  });

  it('оба соседа исчезли из файла руками — позиция, а не потеря', () => {
    writeFileSync(claudeMd, file('A', 'B', 'C', 'D'));
    toggle('C', false);
    // Человек переписал файл целиком: соседей C больше нет.
    writeFileSync(claudeMd, file('X', 'Y', 'Z', 'W'));
    toggle('C', true);
    expect(read()).toBe(file('X', 'Y', 'C', 'Z', 'W'));
  });

  it('пакетный тумблер группы тоже возвращает правило на место', () => {
    writeFileSync(claudeMd, file('A', 'B', 'C'));
    setRulesEnabled(claudeMd, new Map([[idOf('B'), false]]), store);
    expect(read()).toBe(file('A', 'C'));
    setRulesEnabled(claudeMd, new Map([[idOf('B'), true]]), store);
    expect(read()).toBe(file('A', 'B', 'C'));
  });

  it('правка выключенного правила не трогает CLAUDE.md и не плодит копию', () => {
    writeFileSync(claudeMd, file('A', 'B', 'C'));
    toggle('B', false);
    const before = read();
    const id = idOf('B');
    const backup = saveRule(
      claudeMd,
      id,
      { title: 'B2', body: 'Новый текст.', isEnabled: false, groupIds: [] },
      store,
      join(dir, 'backups'),
    );
    expect(backup).toBeUndefined();
    expect(read()).toBe(before);
    toggle('B2', true);
    expect(read()).toBe(
      `${['# Шапка\n\nСвободный абзац.', rule('A'), rule('B2', 'Новый текст.'), rule('C')].join('\n\n')}\n`,
    );
  });

  // Ревью 28.09 (F-166): сосед искался по заголовку ПЕРВЫМ вхождением — при
  // тёзках с диска правило вставало за первым из них, а не за своим.
  it('тёзки-соседи: правило возвращается за СВОЕГО тёзку', () => {
    writeFileSync(claudeMd, file('A', 'X', 'Y', 'X', 'B'));
    toggle('B', false);
    expect(read()).toBe(file('A', 'X', 'Y', 'X'));
    toggle('B', true);
    expect(read()).toBe(file('A', 'X', 'Y', 'X', 'B'));
  });

  it('сосед переименован — место следует за ним', () => {
    writeFileSync(claudeMd, file('A', 'B', 'C'));
    toggle('B', false);
    saveRule(
      claudeMd,
      idOf('A'),
      { title: 'A2', body: 'Текст A.', isEnabled: true, groupIds: [] },
      store,
    );
    toggle('B', true);
    expect(read()).toBe(
      `${['# Шапка\n\nСвободный абзац.', rule('A2', 'Текст A.'), rule('B'), rule('C')].join('\n\n')}\n`,
    );
  });

  it('прежний служебный раздел читается и при первой записи уходит из файла', () => {
    writeFileSync(
      claudeMd,
      `${file('A', 'C').trimEnd()}\n\n## Отключённые правила (AgentDeck)\n\nПояснение.\n\n### B\n\nТекст B.\n`,
    );
    expect(readRules(claudeMd, store).find((item) => item.title === 'B')?.isEnabled).toBe(false);
    toggle('B', true);
    // Место прежнего раздела неизвестно — правило встаёт в конец.
    expect(read()).toBe(file('A', 'C', 'B'));
    expect(read()).not.toContain('Отключённые правила');
  });

  // Ревью 28.09 (F-34): выключенное B вернули старой копией файла, где B лежит
  // в прежнем служебном разделе, — снимок из состояния давал второго B («b-2»).
  it('старая копия со служебным разделом не рождает тёзку выключенного правила', () => {
    writeFileSync(claudeMd, file('A', 'B', 'C'));
    toggle('B', false);
    writeFileSync(
      claudeMd,
      `${file('A', 'C').trimEnd()}\n\n## Отключённые правила (AgentDeck)\n\nПояснение.\n\n### B\n\nТекст B.\n`,
    );
    expect(readRules(claudeMd, store).map((item) => item.title)).toEqual(['A', 'C', 'B']);
    toggle('A', true);
    expect(readRules(claudeMd, store).map((item) => item.title)).toEqual(['A', 'C', 'B']);
    expect(store.getDisabledRules().map((item) => item.title)).toEqual(['B']);
  });

  it('файл не записался — состояние откатывается, правило не пропадает', () => {
    writeFileSync(claudeMd, file('A', 'B'));
    vi.spyOn(safeIo, 'writeTextFile').mockImplementation(() => {
      throw new Error('EPERM');
    });
    expect(() => toggle('B', false)).toThrow('EPERM');
    vi.restoreAllMocks();
    expect(store.getDisabledRules()).toEqual([]);
    expect(read()).toBe(file('A', 'B'));
  });

  it('файл вернули из «Истории» с правилом — тёзки-призрака нет', () => {
    writeFileSync(claudeMd, file('A', 'B'));
    toggle('B', false);
    store.setEnabled('rule', idOf('B'), true);
    writeFileSync(claudeMd, file('A', 'B'));
    const titles = readRules(claudeMd, store).map((item) => item.title);
    expect(titles).toEqual(['A', 'B']);
  });
});

describe('rules: занятый заголовок (D-A)', () => {
  const list = [
    { id: 'test', title: 'Тест', body: '', order: 0, isEnabled: true, groupIds: [], scope: 'g' },
    { id: 'test-2', title: 'Тест', body: '', order: 1, isEnabled: true, groupIds: [], scope: 'g' },
    {
      id: 'drugoe',
      title: 'Другое',
      body: '',
      order: 2,
      isEnabled: false,
      groupIds: [],
      scope: 'g',
    },
  ];

  it('создание с занятым заголовком — отказ 409 с кодом и названием', () => {
    let caught: unknown;
    try {
      assertRuleTitleFree(list, '', '  тест ');
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(RuleTitleTakenError);
    expect(caught).toMatchObject({
      statusCode: 409,
      code: 'rule_title_taken',
      messageCode: 'rule-title-taken',
      params: { title: 'Тест' },
    });
  });

  it('заголовок выключенного правила тоже занят', () => {
    expect(() => assertRuleTitleFree(list, '', 'Другое')).toThrow(RuleTitleTakenError);
  });

  it('переименование в чужой заголовок — отказ', () => {
    expect(() => assertRuleTitleFree(list, 'drugoe', 'Тест')).toThrow(RuleTitleTakenError);
  });

  it('тёзки с диска правятся без смены заголовка', () => {
    expect(() => assertRuleTitleFree(list, 'test-2', 'Тест')).not.toThrow();
  });

  it('свободный заголовок проходит', () => {
    expect(() => assertRuleTitleFree(list, '', 'Новое')).not.toThrow();
  });
});
