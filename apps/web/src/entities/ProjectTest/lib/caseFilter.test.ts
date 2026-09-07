import { describe, it, expect } from 'vitest';
import type { ProjectTestCase, ProjectTestGroup } from '@agentdeck/contracts';
import {
  allCases,
  buildSectionTree,
  collectFacets,
  flattenSections,
  matchesFilter,
} from './caseFilter';

/**
 * Отбор кейсов должен работать так же, как он работает на сервере: по нему
 * человек и смотрит список, и сохраняет набор, и запускает прогон. Расхождение
 * здесь означает, что показанное на экране и ушедшее на проверку — разные вещи.
 */
const make = (part: Partial<ProjectTestCase> & { id: string }): ProjectTestCase => ({
  type: 'case',
  title: part.id,
  steps: [],
  status: 'unknown',
  source: 'human',
  ...part,
});

describe('matchesFilter', () => {
  it('пустой фильтр ничего не сужает', () => {
    expect(matchesFilter(make({ id: 'a' }), {})).toBe(true);
  });

  it('архивные скрыты, пока их не попросили', () => {
    const archived = make({ id: 'a', archived: true });
    expect(matchesFilter(archived, {})).toBe(false);
    expect(matchesFilter(archived, { includeArchived: true })).toBe(true);
  });

  it('карантин отбирается трёхзначно: только он, всё кроме него, вперемешку', () => {
    const quiet = make({ id: 'a', muted: true });
    const loud = make({ id: 'b' });
    expect(matchesFilter(quiet, {})).toBe(true);
    expect(matchesFilter(quiet, { muted: true })).toBe(true);
    expect(matchesFilter(quiet, { muted: false })).toBe(false);
    expect(matchesFilter(loud, { muted: true })).toBe(false);
    expect(matchesFilter(loud, { muted: false })).toBe(true);
  });

  it('секция включает свои подсекции, но не соседей с общим началом', () => {
    const nested = make({ id: 'a', section: 'Чат/Вложения' });
    const sibling = make({ id: 'b', section: 'Чаты' });
    expect(matchesFilter(nested, { sections: ['Чат'] })).toBe(true);
    expect(matchesFilter(sibling, { sections: ['Чат'] })).toBe(false);
  });

  it('незаданная важность считается средней, готовность — черновиком', () => {
    const bare = make({ id: 'a' });
    expect(matchesFilter(bare, { priorities: ['medium'] })).toBe(true);
    expect(matchesFilter(bare, { priorities: ['blocker'] })).toBe(false);
    expect(matchesFilter(bare, { readiness: ['draft'] })).toBe(true);
  });

  it('незаданная автоматизация считается ручной', () => {
    expect(matchesFilter(make({ id: 'a' }), { automation: ['manual'] })).toBe(true);
    expect(matchesFilter(make({ id: 'a' }), { automation: ['automated'] })).toBe(false);
  });

  it('тег ищется среди тегов кейса, а не по совпадению всего списка', () => {
    const tagged = make({ id: 'a', tags: ['smoke', 'chat'] });
    expect(matchesFilter(tagged, { tags: ['chat'] })).toBe(true);
    expect(matchesFilter(tagged, { tags: ['api'] })).toBe(false);
  });

  it('статус и тип отбираются точным совпадением', () => {
    const failed = make({ id: 'a', status: 'failed', type: 'checklist' });
    expect(matchesFilter(failed, { statuses: ['failed'] })).toBe(true);
    expect(matchesFilter(failed, { statuses: ['passed'] })).toBe(false);
    expect(matchesFilter(failed, { types: ['checklist'] })).toBe(true);
    expect(matchesFilter(failed, { types: ['case'] })).toBe(false);
  });

  it('зона отбирается точным совпадением, пустая зона считается пустой строкой', () => {
    expect(matchesFilter(make({ id: 'a', area: 'чат' }), { areas: ['чат'] })).toBe(true);
    expect(matchesFilter(make({ id: 'a' }), { areas: ['чат'] })).toBe(false);
  });

  it('подстрока ищется и по шагам, и по цели, и по тегам, без учёта регистра', () => {
    const item = make({
      id: 'a',
      title: 'Отправка',
      purpose: 'проверить кнопку',
      tags: ['smoke'],
      steps: [{ action: 'нажать «Отправить»', expected: 'сообщение ушло' }],
    });
    expect(matchesFilter(item, { query: 'ОТПРАВИТЬ' })).toBe(true);
    expect(matchesFilter(item, { query: 'кнопку' })).toBe(true);
    expect(matchesFilter(item, { query: 'smoke' })).toBe(true);
    expect(matchesFilter(item, { query: 'аналитика' })).toBe(false);
    expect(matchesFilter(item, { query: '   ' })).toBe(true);
  });
});

describe('collectFacets', () => {
  it('собирает только встретившиеся значения и сортирует их', () => {
    const facets = collectFacets([
      make({ id: 'a', area: 'чат', section: 'Б', tags: ['x'] }),
      make({ id: 'b', area: 'аналитика', section: 'А', tags: ['x', 'y'] }),
      make({ id: 'c' }),
    ]);
    expect(facets.areas).toEqual(['аналитика', 'чат']);
    expect(facets.sections).toEqual(['А', 'Б']);
    expect(facets.tags).toEqual(['x', 'y']);
  });
});

describe('buildSectionTree', () => {
  it('строит ветки по путям и считает кейсы вместе с вложенными', () => {
    const tree = buildSectionTree([
      make({ id: 'a', section: 'Чат/Вложения' }),
      make({ id: 'b', section: 'Чат/Отправка' }),
      make({ id: 'c', section: 'Аналитика' }),
      make({ id: 'd' }),
    ]);

    const flat = flattenSections(tree);
    expect(flat.map((node) => node.path)).toEqual([
      'Аналитика',
      'Чат',
      'Чат/Вложения',
      'Чат/Отправка',
    ]);
    expect(flat.find((node) => node.path === 'Чат')?.count).toBe(2);
    expect(flat.find((node) => node.path === 'Чат/Вложения')?.depth).toBe(1);
  });

  it('кейсы без секции дерева не создают', () => {
    expect(buildSectionTree([make({ id: 'a' })])).toEqual([]);
  });
});

describe('allCases', () => {
  const groups: ProjectTestGroup[] = [
    { id: 'gui', title: 'GUI', file: 'gui.tests.json', cases: [make({ id: 'a' })] },
    { id: 'e2e', title: 'E2E', file: 'e2e.tests.json', cases: [make({ id: 'b' })] },
  ];

  it('без группы отдаёт всё с пометкой, откуда кейс', () => {
    expect(allCases(groups).map((item) => `${item.groupId}:${item.testCase.id}`)).toEqual([
      'gui:a',
      'e2e:b',
    ]);
  });

  it('с группой отдаёт только её', () => {
    expect(allCases(groups, 'e2e')).toHaveLength(1);
  });
});
