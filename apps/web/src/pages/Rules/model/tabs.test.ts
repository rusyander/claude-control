import { describe, it, expect } from 'vitest';
import { rulesInTab } from './tabs';
import { rulesShownInTab } from './rulesShownInTab';

const ON = { id: 'a', isEnabled: true };
const OFF = { id: 'b', isEnabled: false };
const ON2 = { id: 'c', isEnabled: true };
const ALL = [ON, OFF, ON2];

describe('rulesInTab', () => {
  it('«Все» — без отбора и в порядке файла', () => {
    expect(rulesInTab(ALL, 'all')).toEqual(ALL);
  });

  it('«Включены» — только то, что агент видит', () => {
    expect(rulesInTab(ALL, 'enabled').map((rule) => rule.id)).toEqual(['a', 'c']);
  });

  it('«Выключены» — только выключенные', () => {
    expect(rulesInTab(ALL, 'disabled').map((rule) => rule.id)).toEqual(['b']);
  });
});

describe('rulesShownInTab', () => {
  it('переключённое на вкладке остаётся на ней до смены вкладки', () => {
    const toggledOff = [{ id: 'a', isEnabled: false }, OFF, ON2];
    expect(rulesShownInTab(toggledOff, 'enabled', new Set(['a'])).map((rule) => rule.id)).toEqual([
      'a',
      'c',
    ]);
  });

  it('без переключённых — обычный отбор', () => {
    expect(rulesShownInTab(ALL, 'enabled', new Set()).map((rule) => rule.id)).toEqual(['a', 'c']);
    expect(rulesShownInTab(ALL, 'disabled', new Set()).map((rule) => rule.id)).toEqual(['b']);
  });

  it('чужие отбору и не переключённые на вкладке не попадают', () => {
    expect(rulesShownInTab(ALL, 'disabled', new Set(['zzz'])).map((rule) => rule.id)).toEqual([
      'b',
    ]);
  });
});
