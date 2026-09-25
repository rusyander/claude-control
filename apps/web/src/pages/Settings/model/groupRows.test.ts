import { describe, expect, it } from 'vitest';
import {
  SPLIT_DEFAULTS_BUILTIN,
  type GroupPermissionLevel,
  type SplitDefaults,
} from '@agentdeck/contracts/split-groups';
import type { SplitSettingsView } from '@agentdeck/contracts/task-split';
import { defaultRows, projectRows, toggleDefaultRow, toggleProjectRow } from './groupRows';

/**
 * Строки вкладки «Группы»: проект наследует общие, пока строку не тронули, и
 * строка, вернувшаяся в положение общих, снова наследует — иначе она молча
 * перестала бы следовать за общими правилами.
 */
const defaults = (): SplitDefaults => structuredClone(SPLIT_DEFAULTS_BUILTIN) as SplitDefaults;

const view = (own: Partial<Record<string, GroupPermissionLevel>>): SplitSettingsView =>
  ({
    deliver: true,
    parallel: 8,
    parallelAuto: true,
    profile: {} as SplitSettingsView['profile'],
    permissions: { ...defaults().permissions, ...own },
    permissionsOwn: Object.keys(own),
  }) as SplitSettingsView;

describe('строки разрешений групп', () => {
  it('строка проекта помечена своей только если проект её задал', () => {
    const rows = projectRows(view({ gitWrite: 'human' }));
    expect(rows.find((row) => row.id === 'gitWrite')).toEqual({
      id: 'gitWrite',
      level: 'human',
      own: true,
    });
    expect(rows.find((row) => row.id === 'routine')).toEqual({
      id: 'routine',
      level: 'auto',
      own: false,
    });
    expect(rows.map((row) => row.id)[0]).toBe('routine');
  });

  it('щелчок, отличный от общего, становится своим; совпавший — снова наследует', () => {
    const shared = defaults();
    expect(toggleProjectRow(view({}), shared, 'database', 'notify')).toEqual({
      database: 'notify',
    });
    const withOwn = view({ database: 'auto', gitWrite: 'human' });
    expect(toggleProjectRow(withOwn, shared, 'database', 'human')).toEqual({ gitWrite: 'human' });
  });

  it('общая строка меняется целиком, остальные поля не тронуты', () => {
    const shared = defaults();
    const next = toggleDefaultRow(shared, 'routine', 'notify');
    expect(next.permissions.routine).toBe('notify');
    expect(next.parallelLight).toBe(shared.parallelLight);
    expect(defaultRows(next).every((row) => !row.own)).toBe(true);
  });

  it('затирание истории из коробки у человека (аудит 25.09, L163)', () => {
    const rows = defaultRows(defaults());
    expect(rows.find((row) => row.id === 'gitHistory')?.level).toBe('human');
    expect(defaults().groupQuestions).toBe('plan');
    expect(defaults().permissions.routine).toBe('auto');
  });
});
