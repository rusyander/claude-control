import type { ProjectTestFilter } from '@agentdeck/contracts';

/**
 * Одно условие отбора плашкой: «Статус: провален ×».
 *
 * Подписи — ключами словаря, а не готовым текстом: модель не знает языка
 * интерфейса, и так её можно проверить без i18n. Зона и тег берутся как
 * написаны в кейсах — перевести их нечем.
 */
export interface FilterChip {
  /** Стабильный ключ React: поле и значение. */
  id: string;
  fieldKey: string;
  /** Ключ словаря для значения; нет — показывается `value` как есть. */
  valueKey?: string;
  value: string;
  /** Что дописать в фильтр, чтобы снять ровно это условие. */
  remove: Partial<ProjectTestFilter>;
  /**
   * Условие вида, а не фильтра: «С замечаниями» и порядок по риску. Снимаются
   * своими переключателями — в фильтре их нет, и `remove` у них пуст.
   */
  view?: 'withFindings' | 'sort';
}

/** Условия вида, которые живут рядом с фильтром, но не в нём. */
export interface ChipView {
  withFindings?: boolean;
  sort?: 'file' | 'risk';
}

/** Списочные поля фильтра в порядке строки отбора и префикс словаря их значений. */
const LIST_FIELDS: ReadonlyArray<{
  field: 'statuses' | 'priorities' | 'types' | 'readiness' | 'automation' | 'areas' | 'tags';
  fieldKey: string;
  valuePrefix?: string;
}> = [
  { field: 'statuses', fieldKey: 'tests.library.status', valuePrefix: 'projectTests.status' },
  { field: 'priorities', fieldKey: 'tests.library.priority', valuePrefix: 'tests.priority' },
  { field: 'types', fieldKey: 'tests.library.type', valuePrefix: 'tests.kind' },
  { field: 'readiness', fieldKey: 'tests.library.readiness', valuePrefix: 'tests.readiness' },
  { field: 'automation', fieldKey: 'tests.library.automation', valuePrefix: 'tests.automation' },
  { field: 'areas', fieldKey: 'tests.library.area' },
  { field: 'tags', fieldKey: 'tests.library.tag' },
];

/**
 * Условия отбора, которые не видны без раскрытой панели фильтров.
 *
 * Поиск и одна секция плашек не дают: первый виден в своём поле, вторая —
 * выделенной веткой дерева, и повтор плашкой только удлинял бы строку. Группа
 * кейсов и несколько секций разом (сохранённый вид, `?filter` из командной
 * строки) в дереве не видны — им плашка нужна (F-325). Порядок — порядок
 * полей в панели, а не в объекте: иначе плашки переставлялись бы от того, в
 * какой последовательности человек выбирал условия.
 */
export function filterChips(filter: ProjectTestFilter, view: ChipView = {}): FilterChip[] {
  const chips: FilterChip[] = [];

  for (const { field, fieldKey, valuePrefix } of LIST_FIELDS) {
    const values: readonly string[] = filter[field] ?? [];
    for (const value of values) {
      // Крестик снимает только своё значение: набор или `?filter` из командной
      // строки несут несколько, и остальные должны остаться.
      const rest = values.filter((other) => other !== value);
      chips.push({
        id: `${field}:${value}`,
        fieldKey,
        valueKey: valuePrefix ? `${valuePrefix}.${value}` : undefined,
        value,
        remove: { [field]: rest.length > 0 ? rest : undefined },
      });
    }
  }

  for (const value of filter.groupIds ?? []) {
    const rest = (filter.groupIds ?? []).filter((other) => other !== value);
    chips.push({
      id: `groupIds:${value}`,
      fieldKey: 'tests.library.filterGroup',
      value,
      remove: { groupIds: rest.length > 0 ? rest : undefined },
    });
  }

  const sections = filter.sections ?? [];
  if (sections.length > 1) {
    for (const value of sections) {
      chips.push({
        id: `sections:${value}`,
        fieldKey: 'tests.library.filterSection',
        value,
        remove: { sections: sections.filter((other) => other !== value) },
      });
    }
  }

  if (typeof filter.muted === 'boolean') {
    chips.push({
      id: 'muted',
      fieldKey: 'tests.library.muted',
      valueKey: filter.muted ? 'tests.library.mutedOnly' : 'tests.library.mutedWithout',
      value: String(filter.muted),
      remove: { muted: undefined },
    });
  }

  if (filter.includeArchived) {
    chips.push({
      id: 'archived',
      fieldKey: 'tests.library.archived',
      value: '',
      remove: { includeArchived: undefined },
    });
  }

  // Счётчик «Фильтры · N» считает и их — без плашки число в свёрнутой строке
  // называло условие, которого не видно и нечем снять.
  if (view.withFindings) {
    chips.push({
      id: 'findings',
      fieldKey: 'tests.health.filter',
      value: '',
      remove: {},
      view: 'withFindings',
    });
  }

  // Порядок ничего не прячет, но переставляет строки — свёрнутая строка должна
  // сказать, что список не в порядке файла.
  if (view.sort === 'risk') {
    chips.push({
      id: 'sort',
      fieldKey: 'tests.risk.sort',
      valueKey: 'tests.risk.sortRisk',
      value: 'risk',
      remove: {},
      view: 'sort',
    });
  }

  return chips;
}
