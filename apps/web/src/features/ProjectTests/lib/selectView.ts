import type { CaseWithGroup, CaseFacets, SectionNode } from '@entities/ProjectTest';
import type {
  ProjectTestRiskItem,
  ProjectTestGroup,
  ProjectTestFilter,
  ProjectTestCase,
} from '@agentdeck/contracts';
import type { TestSort } from '../model/useTestFilters.types';
import {
  allCases,
  buildSectionTree,
  matchesFilter,
  collectFacets,
  flattenSections,
} from '@entities/ProjectTest';

/** Всё, что следует из отбора: список, счётчик, значения фильтров и дерево. */
export interface LibraryView {
  filtered: CaseWithGroup[];
  total: number;
  facets: CaseFacets;
  sections: SectionNode[];
  flatSections: SectionNode[];
}

/**
 * Порядок по риску: сначала самое дорогое.
 *
 * Кейс, которого нет в отчёте риска (отчёт ещё едет или кейс завели секунду
 * назад), уходит в конец, но НЕ исчезает: список на экране обязан остаться тем
 * же списком, каким бы ни был порядок. Равные — по названию, чтобы строки не
 * прыгали между перерисовками.
 */
export function sortByRisk(
  rows: CaseWithGroup[],
  risk: Map<string, ProjectTestRiskItem>,
): CaseWithGroup[] {
  return [...rows].sort((left, right) => {
    const byScore =
      (risk.get(`${right.groupId}:${right.testCase.id}`)?.score ?? -1) -
      (risk.get(`${left.groupId}:${left.testCase.id}`)?.score ?? -1);
    return byScore || left.testCase.title.localeCompare(right.testCase.title);
  });
}

/**
 * Чистый отбор: те же кейсы, тот же фильтр — тот же экран.
 *
 * Собран одной функцией, а не цепочкой `useMemo`, чтобы его можно было
 * проверить без React: именно здесь решается, что человек видит и что уйдёт в
 * прогон, и ошибка тут не видна ни в одном типе.
 */
export function selectView(
  groups: ProjectTestGroup[],
  groupId: string | undefined,
  filter: ProjectTestFilter,
  findingIds?: Set<string>,
  order?: { sort: TestSort; risk: Map<string, ProjectTestRiskItem> },
): LibraryView {
  const scoped = allCases(groups, groupId);
  const cases = scoped.map((item) => item.testCase);

  // Дерево и списки значений строятся по видимому набору без архива: архивные
  // кейсы иначе тянули бы за собой секции, которых на экране нет.
  const visible = cases.filter((item: ProjectTestCase) => filter.includeArchived || !item.archived);
  const sections = buildSectionTree(visible);

  const filtered = scoped.filter(
    (item) =>
      matchesFilter(item.testCase, filter) &&
      (!findingIds || findingIds.has(`${item.groupId}:${item.testCase.id}`)),
  );

  return {
    filtered: order?.sort === 'risk' ? sortByRisk(filtered, order.risk) : filtered,
    total: scoped.length,
    facets: collectFacets(visible),
    sections,
    flatSections: flattenSections(sections),
  };
}
