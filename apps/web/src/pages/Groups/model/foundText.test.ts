import { describe, expect, it } from 'vitest';
import type { DiscoveredGroup } from '@agentdeck/contracts';
import { foundText, uiLang } from './foundText';

const base: DiscoveredGroup = {
  key: 'c:/work/shop#release',
  name: 'Release checklist',
  when: 'When shipping a release',
  why: 'The skill and its hooks ship a release together.',
  foundIn: 'c:/work/shop',
  usedIn: [],
  members: [],
  steps: [],
  inventoryHash: 'h',
  status: 'new',
};

const localized: DiscoveredGroup = {
  ...base,
  localized: {
    name: { ru: 'Чек-лист релиза', en: 'Release checklist' },
    when: { ru: 'Когда выпускаем релиз', en: 'When shipping a release' },
    why: { ru: '', en: 'The skill and its hooks ship a release together.' },
  },
};

describe('foundText: находка на языке интерфейса', () => {
  it('русский интерфейс получает русскую сторону пары', () => {
    expect(foundText(localized, 'ru')).toEqual({
      name: 'Чек-лист релиза',
      when: 'Когда выпускаем релиз',
      // Пустая сторона — вторая, а не пустая строка.
      why: 'The skill and its hooks ship a release together.',
    });
  });

  it('английский интерфейс получает английскую сторону', () => {
    expect(foundText(localized, 'en-US').name).toBe('Release checklist');
  });

  it('находка старого вида показывается как есть', () => {
    expect(foundText(base, 'ru').name).toBe('Release checklist');
  });

  it('uiLang сводит язык к ru/en', () => {
    expect(uiLang('en-GB')).toBe('en');
    expect(uiLang('ru')).toBe('ru');
  });
});
