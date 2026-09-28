import { describe, it, expect } from 'vitest';
import { filterChips } from './filterChips';

/**
 * Свёрнутая строка отбора показывает условия плашками — и каждая плашка обязана
 * снимать РОВНО своё условие: плашка, которая снимает соседнее или не снимает
 * ничего, врёт о том, что стоит на экране.
 */
describe('filterChips', () => {
  it('пустой отбор — плашек нет', () => {
    expect(filterChips({})).toEqual([]);
  });

  it('поиск и одна секция плашек не дают: они и так видны в поле и в дереве', () => {
    expect(filterChips({ query: 'чат', sections: ['Чат'] })).toEqual([]);
  });

  it('группа и несколько секций — плашками: в дереве их не видно (F-325)', () => {
    // Сохранённый вид из командной строки несёт их, и без плашки строка
    // отбора молчала бы об условии, которое режет список.
    const chips = filterChips({ groupIds: ['gui'], sections: ['Чат', 'Настройки'] });
    expect(chips.map((chip) => [chip.fieldKey, chip.value])).toEqual([
      ['tests.library.filterGroup', 'gui'],
      ['tests.library.filterSection', 'Чат'],
      ['tests.library.filterSection', 'Настройки'],
    ]);
    expect(chips[1]?.remove).toEqual({ sections: ['Настройки'] });
    expect(Object.keys(chips[0]?.remove ?? {})).toEqual(['groupIds']);
  });

  it('списочные поля — плашка на значение, подпись из словаря', () => {
    const chips = filterChips({ statuses: ['failed'], priorities: ['blocker'] });
    expect(chips.map((chip) => [chip.fieldKey, chip.valueKey])).toEqual([
      ['tests.library.status', 'projectTests.status.failed'],
      ['tests.library.priority', 'tests.priority.blocker'],
    ]);
    // Ключ обязан БЫТЬ в объекте: `patch({})` ничего не снимает, а toEqual
    // считает `{ statuses: undefined }` равным пустому объекту.
    expect(Object.keys(chips[0]?.remove ?? {})).toEqual(['statuses']);
  });

  it('зона и тег — как написаны в кейсах, без словаря', () => {
    const [area, tag] = filterChips({ areas: ['чат'], tags: ['дым'] });
    expect(area).toMatchObject({ fieldKey: 'tests.library.area', value: 'чат' });
    expect(area?.valueKey).toBeUndefined();
    expect(tag).toMatchObject({ fieldKey: 'tests.library.tag', value: 'дым' });
    expect(Object.keys(tag?.remove ?? {})).toEqual(['tags']);
  });

  it('карантин трёхзначный: «без карантина» — тоже условие, и снимается в «любой»', () => {
    const [without] = filterChips({ muted: false });
    expect(without?.valueKey).toBe('tests.library.mutedWithout');
    expect(Object.keys(without?.remove ?? {})).toEqual(['muted']);
    expect(filterChips({ muted: true })[0]?.valueKey).toBe('tests.library.mutedOnly');
  });

  it('архив — отдельная плашка, снимается выключением', () => {
    const [archived] = filterChips({ includeArchived: true });
    expect(archived?.fieldKey).toBe('tests.library.archived');
    expect(Object.keys(archived?.remove ?? {})).toEqual(['includeArchived']);
  });

  it('крестик снимает ТОЛЬКО своё значение: остальные значения поля остаются', () => {
    // Набор или `?filter` из командной строки несут несколько значений поля;
    // крестик на «провален» не должен молча снимать и «заблокирован».
    const [failed, blocked] = filterChips({ statuses: ['failed', 'blocked'] });
    expect(failed?.remove).toEqual({ statuses: ['blocked'] });
    expect(blocked?.remove).toEqual({ statuses: ['failed'] });
    const [only] = filterChips({ tags: ['дым'] });
    expect(Object.keys(only?.remove ?? {})).toEqual(['tags']);
    expect(only?.remove.tags).toBeUndefined();
  });

  it('«С замечаниями» и порядок по риску — тоже плашки: счётчик без плашки врёт', () => {
    const chips = filterChips({}, { withFindings: true, sort: 'risk' });
    expect(chips.map((chip) => [chip.id, chip.fieldKey, chip.valueKey, chip.view])).toEqual([
      ['findings', 'tests.health.filter', undefined, 'withFindings'],
      ['sort', 'tests.risk.sort', 'tests.risk.sortRisk', 'sort'],
    ]);
    expect(filterChips({}, { withFindings: false, sort: 'file' })).toEqual([]);
  });

  it('порядок плашек не зависит от порядка полей в объекте', () => {
    const one = filterChips({ tags: ['a'], statuses: ['passed'] }).map((chip) => chip.id);
    const two = filterChips({ statuses: ['passed'], tags: ['a'] }).map((chip) => chip.id);
    expect(one).toEqual(two);
  });
});
