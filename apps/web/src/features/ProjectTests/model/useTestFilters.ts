import { useMemo, useState } from 'react';
import type {
  ProjectTestFilter,
  ProjectTestGroup,
  ProjectTestRiskItem,
} from '@agentdeck/contracts';
import { type CaseFacets, type CaseWithGroup, type SectionNode } from '@entities/ProjectTest';
import { dropEmpty } from '../lib/dropEmpty';
import type { TestSort } from './useTestFilters.types';
import { selectView } from '../lib/selectView';

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
