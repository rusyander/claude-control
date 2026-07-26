import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { Group } from '@claude-control/contracts';
import { AppStore } from '../lib/app-store.ts';
import { readRules, saveRule, deleteRule } from './rules.ts';

/**
 * Правка заголовка правила = смена его идентификатора: id выводится из
 * заголовка при каждом разборе CLAUDE.md, своего ключа на диске у правила нет.
 * Значит вместе с заголовком обязаны переехать и отметки в state.json —
 * ручное выключение, гашение группой, состав групп. Без переноса правило
 * теряло значок группы, групповой переключатель переставал его находить, а
 * мусор оставался в состоянии навсегда.
 */
describe('Переименование правила переносит отметки состояния', () => {
  let dir: string;
  let claudeMdPath: string;
  let store: AppStore;

  const claudeMd = [
    '# Личные правила',
    '',
    '## ПРАВИЛО: Язык общения',
    '',
    'Отвечать по-русски.',
    '',
    '## ПРАВИЛО: Второе правило',
    '',
    'Тело второго правила.',
    '',
  ].join('\n');

  const putGroup = (memberId: string): void => {
    store.saveGroup({
      id: 'g1',
      name: 'Работа',
      description: '',
      color: 'accent',
      icon: 'folder',
      members: [{ kind: 'rule', id: memberId }],
      env: {},
      isEnabled: true,
      order: 0,
    } satisfies Group);
  };

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'cc-rules-rename-'));
    claudeMdPath = join(dir, 'CLAUDE.md');
    writeFileSync(claudeMdPath, claudeMd);
    store = new AppStore(join(dir, 'claude-control'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('правило остаётся в группе после смены заголовка', () => {
    putGroup('yazyk-obscheniya');

    saveRule(
      claudeMdPath,
      'yazyk-obscheniya',
      { title: 'Язык ответов', body: 'Отвечать по-русски.', isEnabled: true, groupIds: [] },
      store,
    );

    const rules = readRules(claudeMdPath, store);
    const renamed = rules.find((rule) => rule.id === 'yazyk-otvetov');

    expect(renamed).toBeDefined();
    expect(renamed?.groupIds).toEqual(['g1']);
    // Старый id не должен остаться ни в составе группы, ни где-либо ещё.
    expect(store.getGroupIdsFor('rule', 'yazyk-obscheniya')).toEqual([]);
    expect(store.getGroups()[0]?.members).toEqual([{ kind: 'rule', id: 'yazyk-otvetov' }]);
  });

  it('гашение группой переезжает на новый id — переключатель группы не теряет правило', () => {
    putGroup('yazyk-obscheniya');
    store.setGroupDisabled('rule', 'yazyk-obscheniya', 'g1', true);

    saveRule(
      claudeMdPath,
      'yazyk-obscheniya',
      { title: 'Язык ответов', body: 'Отвечать по-русски.', isEnabled: false, groupIds: [] },
      store,
    );

    expect(store.disablingGroups('rule', 'yazyk-obscheniya')).toEqual([]);
    expect(store.disablingGroups('rule', 'yazyk-otvetov')).toEqual(['g1']);
  });

  it('ручное выключение переезжает вместе с заголовком', () => {
    store.setEnabled('rule', 'yazyk-obscheniya', false);

    saveRule(
      claudeMdPath,
      'yazyk-obscheniya',
      { title: 'Язык ответов', body: 'Отвечать по-русски.', isEnabled: false, groupIds: [] },
      store,
    );

    expect(store.isDisabledManually('rule', 'yazyk-obscheniya')).toBe(false);
    expect(store.isDisabledManually('rule', 'yazyk-otvetov')).toBe(true);
    expect(readRules(claudeMdPath, store).find((r) => r.id === 'yazyk-otvetov')?.isEnabled).toBe(
      false,
    );
  });

  it('заголовок не менялся — отметки остаются на месте', () => {
    putGroup('yazyk-obscheniya');

    saveRule(
      claudeMdPath,
      'yazyk-obscheniya',
      { title: 'Язык общения', body: 'Новое тело.', isEnabled: true, groupIds: [] },
      store,
    );

    expect(store.getGroupIdsFor('rule', 'yazyk-obscheniya')).toEqual(['g1']);
  });

  /**
   * Два правила-тёзки меняются идентификаторами местами: выключение первого
   * уводит его в конец файла, и `тест` ↔ `тест-2` обмениваются. Последовательный
   * перенос («test-2» → «test», затем «test» → «test-2») тащил отметки первого
   * правила во второе — группа оказывалась на чужом правиле.
   */
  it('обмен id между тёзками не путает их отметки', () => {
    writeFileSync(
      claudeMdPath,
      ['## ПРАВИЛО: Тест', '', 'Первое.', '', '## ПРАВИЛО: Тест', '', 'Второе.', ''].join('\n'),
    );
    // Группа на ВТОРОМ правиле (тело «Второе.»).
    putGroup('test-2');

    // Выключаем первое: сборка выносит его в конец, второе становится «test».
    saveRule(
      claudeMdPath,
      'test',
      { title: 'Тест', body: 'Первое.', isEnabled: false, groupIds: [] },
      store,
    );

    const rules = readRules(claudeMdPath, store);
    const second = rules.find((rule) => rule.body === 'Второе.');
    const first = rules.find((rule) => rule.body === 'Первое.');

    expect(second?.id).toBe('test');
    expect(second?.groupIds).toEqual(['g1']);
    expect(first?.groupIds).toEqual([]);
    expect(store.getGroups()[0]?.members).toEqual([{ kind: 'rule', id: 'test' }]);
  });

  /**
   * Тело правила может содержать собственную строку «## ПРАВИЛО:» — при
   * следующем разборе файл распадётся на большее число правил. Раньше перенос
   * сверял свой список с повторным разбором и при расхождении длин молча
   * отказывался: правило переименовано, а его группа осталась на мёртвом id.
   */
  it('строка «## ПРАВИЛО:» в теле не отменяет перенос отметок', () => {
    writeFileSync(
      claudeMdPath,
      ['## ПРАВИЛО: Первое', '', 'Пример разметки:', '', '## ПРАВИЛО: подделка', ''].join('\n'),
    );
    putGroup('pervoe');

    saveRule(
      claudeMdPath,
      'pervoe',
      {
        title: 'Второе',
        body: 'Пример разметки:\n\n## ПРАВИЛО: подделка',
        isEnabled: true,
        groupIds: [],
      },
      store,
    );

    expect(store.getGroupIdsFor('rule', 'pervoe')).toEqual([]);
    expect(store.getGroupIdsFor('rule', 'vtoroe')).toEqual(['g1']);
  });

  it('удаление тёзки сдвигает id уцелевшего — отметки едут за ним', () => {
    // Два правила с одинаковым заголовком: разбор различает их суффиксом «-2».
    writeFileSync(
      claudeMdPath,
      ['## ПРАВИЛО: Тёзка', '', 'Первое.', '', '## ПРАВИЛО: Тёзка', '', 'Второе.', ''].join('\n'),
    );
    putGroup('tezka-2');

    deleteRule(claudeMdPath, 'tezka', store);

    const rules = readRules(claudeMdPath, store);
    expect(rules.map((rule) => rule.id)).toEqual(['tezka']);
    expect(rules[0]?.groupIds).toEqual(['g1']);
  });
});
