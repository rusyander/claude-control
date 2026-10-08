import { describe, it, expect } from 'vitest';
import { scriptTab } from './tabs';
import { scriptsInTab } from './scriptsInTab';

const USED = { name: 'guard.mjs', isUsed: true };
const USED_TEST = { name: 'tests/guard.test.mjs', isUsed: true, isTest: true };
const TEST = { name: 'tests/fixture.json', isUsed: false, isTest: true };
const UNUSED = { name: 'old.mjs', isUsed: false };
const ALL = [USED, USED_TEST, TEST, UNUSED];

describe('scriptTab', () => {
  it('привязанный тест считается привязанным — его удаление ломает хук', () => {
    expect(scriptTab(USED_TEST)).toBe('used');
  });

  it('непривязанный тест — в тестах, а не в забытых', () => {
    expect(scriptTab(TEST)).toBe('test');
  });

  it('без привязки и не тест — в «не привязаны»', () => {
    expect(scriptTab(UNUSED)).toBe('unused');
  });
});

describe('scriptsInTab', () => {
  it('«Все» — без отбора', () => {
    expect(scriptsInTab(ALL, 'all')).toEqual(ALL);
  });

  it('каждый файл ровно в одной вкладке-отборе: сумма счётчиков равна «Все»', () => {
    const used = scriptsInTab(ALL, 'used');
    const unused = scriptsInTab(ALL, 'unused');
    const test = scriptsInTab(ALL, 'test');
    expect(used.map((s) => s.name)).toEqual(['guard.mjs', 'tests/guard.test.mjs']);
    expect(unused.map((s) => s.name)).toEqual(['old.mjs']);
    expect(test.map((s) => s.name)).toEqual(['tests/fixture.json']);
    expect(used.length + unused.length + test.length).toBe(ALL.length);
  });
});
