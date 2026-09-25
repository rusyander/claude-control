import { describe, it, expect } from 'vitest';
import type { AppState } from './app-store.types.ts';
import { getSplitSettings, setSplitSettings } from './split-settings.ts';

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
