import { describe, it, expect } from 'vitest';
import type {
  ProjectTestCase,
  ProjectTestGroup,
  ProjectTestRiskItem,
} from '@agentdeck/contracts';
import { dropEmpty, selectView } from './useTestFilters';

/**
 * Отбор библиотеки: то, что видно на экране, и есть то, что уйдёт в прогон и в
 * сохранённый набор. Поэтому проверяется именно чистая выборка, а не разметка.
 */
const make = (part: Partial<ProjectTestCase> & { id: string }): ProjectTestCase => ({
  type: 'case',
  title: part.id,
  steps: [],
  status: 'unknown',
  source: 'human',
  ...part,
});

const groups: ProjectTestGroup[] = [
  {
    id: 'gui',
    title: 'GUI',
    file: 'gui.tests.json',
    cases: [
      make({ id: 'a', section: 'Чат/Отправка', area: 'чат', tags: ['smoke'] }),
      make({ id: 'b', section: 'Чат/Вложения', area: 'чат', priority: 'blocker' }),
      make({ id: 'old', section: 'Архив', archived: true }),
    ],
  },
  {
    id: 'api',
    title: 'API',
    file: 'api.tests.json',
    cases: [make({ id: 'c', section: 'Аналитика', area: 'аналитика' })],
  },
];

describe('selectView', () => {
  it('без группы берёт все кейсы, с группой — только её', () => {
    expect(selectView(groups, undefined, {}).total).toBe(4);
    expect(selectView(groups, 'api', {}).total).toBe(1);
  });

  it('счётчик показывает исходный размер, список — отфильтрованный', () => {
    const view = selectView(groups, 'gui', { priorities: ['blocker'] });
    expect(view.total).toBe(3);
    expect(view.filtered.map((item) => item.testCase.id)).toEqual(['b']);
  });

  it('архив не попадает ни в список, ни в дерево, ни в значения фильтров', () => {
    const view = selectView(groups, 'gui', {});
    expect(view.filtered.map((item) => item.testCase.id)).toEqual(['a', 'b']);
    expect(view.flatSections.map((node) => node.path)).not.toContain('Архив');
    expect(view.facets.sections).not.toContain('Архив');
  });

  it('с показом архива он появляется везде', () => {
    const view = selectView(groups, 'gui', { includeArchived: true });
    expect(view.filtered).toHaveLength(3);
    expect(view.flatSections.map((node) => node.path)).toContain('Архив');
  });

  it('дерево секций считается по всей группе, а не по отобранному', () => {
    // Иначе выбранная ветка исчезала бы ровно в тот момент, когда по ней
    // отфильтровали, и выйти из неё было бы нечем.
    const view = selectView(groups, 'gui', { sections: ['Чат/Отправка'] });
    expect(view.filtered).toHaveLength(1);
    expect(view.flatSections.map((node) => node.path)).toEqual([
      'Чат',
      'Чат/Вложения',
      'Чат/Отправка',
    ]);
  });
});

describe('порядок по риску', () => {
  const risk = new Map<string, ProjectTestRiskItem>(
    [
      { key: 'gui:a', score: 12 },
      { key: 'gui:b', score: 71 },
    ].map((item) => [
      item.key,
      {
        ...item,
        groupId: 'gui',
        caseId: item.key.split(':')[1] ?? '',
        title: item.key,
        factors: [],
        reason: 'причина',
        duration: 5,
        hasDuration: false,
        status: 'unknown',
      } as ProjectTestRiskItem,
    ]),
  );

  it('поднимает наверх самое рискованное', () => {
    const view = selectView(groups, 'gui', {}, undefined, { sort: 'risk', risk });
    expect(view.filtered.map((item) => item.testCase.id)).toEqual(['b', 'a']);
  });

  it('кейс без счёта уходит вниз, но остаётся в списке', () => {
    const view = selectView(groups, 'gui', { includeArchived: true }, undefined, {
      sort: 'risk',
      risk,
    });
    expect(view.filtered.map((item) => item.testCase.id)).toEqual(['b', 'a', 'old']);
  });

  it('порядок файла остаётся порядком файла', () => {
    const view = selectView(groups, 'gui', {}, undefined, { sort: 'file', risk });
    expect(view.filtered.map((item) => item.testCase.id)).toEqual(['a', 'b']);
  });
});

describe('dropEmpty', () => {
  it('выкидывает пустые значения, но оставляет содержательные', () => {
    expect(
      dropEmpty({
        query: '',
        areas: [],
        includeArchived: false,
        tags: ['smoke'],
        sections: undefined,
      }),
    ).toEqual({ tags: ['smoke'] });
  });

  it('включённый показ архива — тоже фильтр', () => {
    expect(dropEmpty({ includeArchived: true })).toEqual({ includeArchived: true });
  });

  it('«без карантина» переживает очистку: у него ложь значима', () => {
    expect(dropEmpty({ muted: false })).toEqual({ muted: false });
    expect(dropEmpty({ muted: true })).toEqual({ muted: true });
    expect(dropEmpty({ muted: undefined })).toEqual({});
  });
});
