import { useMemo, useState } from 'react';
import type {
  ProjectTestCase,
  ProjectTestFilter,
  ProjectTestGroup,
  ProjectTestRiskItem,
} from '@agentdeck/contracts';
import {
  allCases,
  buildSectionTree,
  collectFacets,
  flattenSections,
  matchesFilter,
  type CaseFacets,
  type CaseWithGroup,
  type SectionNode,
} from '@entities/ProjectTest';

/**
 * Отбор кейсов в библиотеке: фильтр, дерево секций и то, что из них следует.
 *
 * Фильтр — ровно тот же объект `ProjectTestFilter`, который уходит в
 * сохранённый набор и в тест-план. Держать отдельное «состояние фильтров
 * списка» и отдельный «фильтр набора» значило бы позволить им разойтись: то,
 * что человек видит на экране, обязано быть тем же, что он сохранит кнопкой.
 *
 * Дерево секций считается по НЕОТФИЛЬТРОВАННОМУ набору группы: иначе выбранная
 * ветка исчезала бы из дерева ровно в тот момент, когда по ней отфильтровали, и
 * из неё нельзя было бы выйти.
 */

export interface TestFilters {
  filter: ProjectTestFilter;
  /** Дописать в фильтр часть полей; `undefined` в поле снимает его. */
  patch: (part: Partial<ProjectTestFilter>) => void;
  reset: () => void;
  /** Применить сохранённый набор целиком. */
  apply: (filter: ProjectTestFilter) => void;
  /** Есть ли вообще что снимать — по этому включается кнопка сброса. */
  isActive: boolean;
  /** Кейсы группы (или всех групп) после отбора. */
  filtered: CaseWithGroup[];
  /** Сколько кейсов было до отбора — чтобы показать «10 из 132». */
  total: number;
  /**
   * Отбор «с замечаниями» — местный, в `ProjectTestFilter` он не входит.
   *
   * Замечания считает линтер по библиотеке «сейчас», их нет ни в одном поле
   * кейса. Положи его в общий фильтр — и он уехал бы в сохранённый набор и в
   * тест-план, где означал бы список кейсов, которого на той машине уже нет.
   */
  withFindings: boolean;
  setWithFindings: (enabled: boolean) => void;
  /** Есть ли вообще замечания — по этому показывается сам переключатель. */
  hasFindings: boolean;
  /**
   * Порядок списка — местный, как и «с замечаниями»: риск считается по истории
   * прогонов ЭТОЙ машины и в сохранённом наборе означал бы чужой порядок.
   */
  sort: TestSort;
  setSort: (sort: TestSort) => void;
  /** Риск кейсов, «группа:кейс» → счёт и причина: по нему сортируют и набирают бюджет. */
  risk: Map<string, ProjectTestRiskItem>;
  facets: CaseFacets;
  sections: SectionNode[];
  flatSections: SectionNode[];
}

const EMPTY: ProjectTestFilter = {};

/**
 * Порядок списка: как он лежит в файле или по риску.
 *
 * Порядок файла — тоже осмысленный: кейсы в нём идут так, как их писали, и
 * секция за секцией читается как сценарий. Поэтому «по риску» — не значение по
 * умолчанию, а взгляд, который включают, когда времени на всё нет.
 */
export type TestSort = 'file' | 'risk';

/** Всё, что следует из отбора: список, счётчик, значения фильтров и дерево. */
export interface LibraryView {
  filtered: CaseWithGroup[];
  total: number;
  facets: CaseFacets;
  sections: SectionNode[];
  flatSections: SectionNode[];
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

/**
 * Порядок по риску: сначала самое дорогое.
 *
 * Кейс, которого нет в отчёте риска (отчёт ещё едет или кейс завели секунду
 * назад), уходит в конец, но НЕ исчезает: список на экране обязан остаться тем
 * же списком, каким бы ни был порядок. Равные — по названию, чтобы строки не
 * прыгали между перерисовками.
 */
function sortByRisk(
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

const NO_RISK = new Map<string, ProjectTestRiskItem>();

export function useTestFilters(
  groups: ProjectTestGroup[],
  groupId: string | undefined,
  findingIds?: Set<string>,
  risk: Map<string, ProjectTestRiskItem> = NO_RISK,
): TestFilters {
  const [filter, setFilter] = useState<ProjectTestFilter>(EMPTY);
  const [withFindings, setWithFindings] = useState(false);
  const [sort, setSort] = useState<TestSort>('file');

  const scope = withFindings ? findingIds : undefined;
  const view = useMemo(
    () => selectView(groups, groupId, filter, scope, { sort, risk }),
    [groups, groupId, filter, scope, sort, risk],
  );

  return {
    filter,
    sort,
    setSort,
    risk,
    patch: (part) => setFilter((current) => dropEmpty({ ...current, ...part })),
    reset: () => {
      setFilter(EMPTY);
      setWithFindings(false);
    },
    apply: (next) => setFilter(dropEmpty(next)),
    isActive: Object.keys(filter).length > 0 || withFindings,
    withFindings,
    setWithFindings,
    hasFindings: (findingIds?.size ?? 0) > 0,
    ...view,
  };
}

/** Пустые поля из фильтра выкидываются: они ничего не сужают, но врут «фильтр стоит». */
export function dropEmpty(filter: ProjectTestFilter): ProjectTestFilter {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(filter)) {
    // Карантин — единственный трёхзначный отбор: `false` здесь значит «спрятать
    // карантин», а не «поле не заполнено», и выкидывать его нельзя.
    if (key === 'muted' && typeof value === 'boolean') {
      result[key] = value;
      continue;
    }
    if (value === undefined || value === false || value === '') continue;
    if (Array.isArray(value) && value.length === 0) continue;
    result[key] = value;
  }
  return result as ProjectTestFilter;
}
