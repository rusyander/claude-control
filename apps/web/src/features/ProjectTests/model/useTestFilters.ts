import { useMemo, useState } from 'react';
import type {
  ProjectTestCase,
  ProjectTestFilter,
  ProjectTestGroup,
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
  facets: CaseFacets;
  sections: SectionNode[];
  flatSections: SectionNode[];
}

const EMPTY: ProjectTestFilter = {};

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
): LibraryView {
  const scoped = allCases(groups, groupId);
  const cases = scoped.map((item) => item.testCase);

  // Дерево и списки значений строятся по видимому набору без архива: архивные
  // кейсы иначе тянули бы за собой секции, которых на экране нет.
  const visible = cases.filter((item: ProjectTestCase) => filter.includeArchived || !item.archived);
  const sections = buildSectionTree(visible);

  return {
    filtered: scoped.filter((item) => matchesFilter(item.testCase, filter)),
    total: scoped.length,
    facets: collectFacets(visible),
    sections,
    flatSections: flattenSections(sections),
  };
}

export function useTestFilters(
  groups: ProjectTestGroup[],
  groupId: string | undefined,
): TestFilters {
  const [filter, setFilter] = useState<ProjectTestFilter>(EMPTY);

  const view = useMemo(() => selectView(groups, groupId, filter), [groups, groupId, filter]);

  return {
    filter,
    patch: (part) => setFilter((current) => dropEmpty({ ...current, ...part })),
    reset: () => setFilter(EMPTY),
    apply: (next) => setFilter(dropEmpty(next)),
    isActive: Object.keys(filter).length > 0,
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
