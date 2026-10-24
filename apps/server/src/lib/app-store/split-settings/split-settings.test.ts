import { describe, it, expect } from 'vitest';
import type { AppState } from '../app-store.types.ts';
import {
  getSplitDefaults,
  getSplitSettings,
  setSplitDefaults,
  setSplitSettings,
} from './split-settings.ts';

/**
 * Запись проекта хранит только отклонение: доставка включена из коробки, а
 * число групп разом без записи — автоподбор, и `null` возвращает к нему.
 */
describe('настройка разделения проекта', () => {
  it('из коробки доставка включена, число групп не задано', () => {
    const state = {} as AppState;
    expect(getSplitSettings(state, 'C:/repo')).toEqual({ deliver: true });
  });

  it('заданное число хранится, null возвращает автоподбор и убирает запись', () => {
    const state = {} as AppState;
    expect(setSplitSettings(state, 'C:/repo', { deliver: true, parallel: 99 })).toEqual({
      deliver: true,
      parallel: 30,
    });
    expect(getSplitSettings(state, 'C:/repo')).toEqual({ deliver: true, parallel: 30 });

    setSplitSettings(state, 'C:/repo', { deliver: true, parallel: null });
    expect(getSplitSettings(state, 'C:/repo')).toEqual({ deliver: true });
    expect(Object.keys(state.splitSettings ?? {})).toEqual([]);
  });

  it('выключенная доставка — отклонение, и оно переживает чтение', () => {
    const state = {} as AppState;
    setSplitSettings(state, 'C:/repo', { deliver: false });
    expect(getSplitSettings(state, 'C:/repo')).toEqual({ deliver: false });
  });
});

/**
 * F-33: запись общих правил хранит только отличие от коробки. До 23.10 коробка
 * «истории git» была `human`, и выбранное человеком «человек» не сохранялось;
 * после смены коробки на `auto` такой выбор молча снимался.
 */
describe('общие правила групп — смена коробки «истории git»', () => {
  it('запись без ревизии (до 23.10) читает «историю git» как человека', () => {
    const state = { splitDefaults: { groupQuestions: 'human' } } as unknown as AppState;
    expect(getSplitDefaults(state).permissions.gitHistory).toBe('human');
    expect(getSplitDefaults(state).groupQuestions).toBe('human');
  });

  it('явное положение в старой записи сильнее чтения по старой коробке', () => {
    const state = {
      splitDefaults: { permissions: { gitHistory: 'auto' } },
    } as unknown as AppState;
    expect(getSplitDefaults(state).permissions.gitHistory).toBe('auto');
  });

  it('записи нет — коробка; новая запись несёт ревизию и читается по новой коробке', () => {
    const state = {} as AppState;
    expect(getSplitDefaults(state).permissions.gitHistory).toBe('auto');
    setSplitDefaults(state, { groupQuestions: 'human' });
    expect(state.splitDefaults).toMatchObject({ revision: 2, groupQuestions: 'human' });
    expect(getSplitDefaults(state).permissions.gitHistory).toBe('auto');
  });

  it('сохранение старой записи из вкладки закрепляет «человека» явно', () => {
    const state = { splitDefaults: { groupQuestions: 'human' } } as unknown as AppState;
    setSplitDefaults(state, getSplitDefaults(state));
    expect(state.splitDefaults?.permissions?.gitHistory).toBe('human');
    expect(state.splitDefaults?.revision).toBe(2);
  });
});
