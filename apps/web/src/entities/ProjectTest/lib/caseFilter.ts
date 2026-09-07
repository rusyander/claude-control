import type {
  ProjectTestCase,
  ProjectTestFilter,
  ProjectTestGroup,
} from '@agentdeck/contracts';
import { stepText } from '@agentdeck/contracts/test-format';

/**
 * Отбор кейсов на клиенте.
 *
 * Тот же `ProjectTestFilter`, что сервер применяет к прогонам и планам, — и
 * применяется он здесь ровно так же. Иначе сохранённый фильтр показывал бы в
 * списке один набор, а прогон по нему брал бы другой, и человек не мог бы
 * заранее увидеть, что именно уедет на проверку.
 *
 * Пустое поле фильтра ничего не сужает: незаполненный отбор — это «всё», а не
 * «ничего».
 */

/** Попал ли кейс под отбор. */
export function matchesFilter(testCase: ProjectTestCase, filter: ProjectTestFilter): boolean {
  if (!filter.includeArchived && testCase.archived) return false;
  if (filter.areas?.length && !filter.areas.includes(testCase.area ?? '')) return false;
  if (filter.types?.length && !filter.types.includes(testCase.type)) return false;
  if (filter.priorities?.length && !filter.priorities.includes(testCase.priority ?? 'medium')) {
    return false;
  }
  if (filter.readiness?.length && !filter.readiness.includes(testCase.readiness ?? 'draft')) {
    return false;
  }
  if (filter.statuses?.length && !filter.statuses.includes(testCase.status)) return false;
  if (
    filter.automation?.length &&
    !filter.automation.includes(testCase.automation?.status ?? 'manual')
  ) {
    return false;
  }
  if (filter.tags?.length && !filter.tags.some((tag) => (testCase.tags ?? []).includes(tag))) {
    return false;
  }
  // Секция задаётся путём («Чат/Вложения») и включает свои подсекции: выбрав
  // ветку дерева, человек ждёт всё, что под ней, а не только её собственные кейсы.
  if (filter.sections?.length) {
    const section = testCase.section ?? '';
    const inBranch = filter.sections.some(
      (item) => section === item || section.startsWith(`${item}/`),
    );
    if (!inBranch) return false;
  }
  if (filter.query) return matchesQuery(testCase, filter.query);
  return true;
}

/** Подстрока по названию, цели, зоне, тегам и тексту шагов. */
function matchesQuery(testCase: ProjectTestCase, query: string): boolean {
  const needle = query.trim().toLowerCase();
  if (!needle) return true;
  const haystack = [
    testCase.title,
    testCase.purpose ?? '',
    testCase.area ?? '',
    testCase.section ?? '',
    (testCase.tags ?? []).join(' '),
    testCase.steps.map((step) => stepText(step)).join(' '),
    testCase.expected ?? '',
  ]
    .join(' ')
    .toLowerCase();
  return haystack.includes(needle);
}

/** Значения, которые реально встречаются в наборе, — из них строится фильтр. */
export interface CaseFacets {
  sections: string[];
  areas: string[];
  tags: string[];
}

export function collectFacets(cases: ProjectTestCase[]): CaseFacets {
  const sections = new Set<string>();
  const areas = new Set<string>();
  const tags = new Set<string>();
  for (const item of cases) {
    if (item.section) sections.add(item.section);
    if (item.area) areas.add(item.area);
    for (const tag of item.tags ?? []) tags.add(tag);
  }
  const sorted = (set: Set<string>): string[] => [...set].sort((a, b) => a.localeCompare(b));
  return { sections: sorted(sections), areas: sorted(areas), tags: sorted(tags) };
}

/** Узел дерева секций: путь, подпись, сколько кейсов под ним и вложенные ветки. */
export interface SectionNode {
  path: string;
  title: string;
  depth: number;
  count: number;
  children: SectionNode[];
}

/**
 * Дерево секций из путей вида «Чат/Вложения».
 *
 * Своего списка секций у проекта нет намеренно: секция — это поле кейса, и
 * дерево строится по тому, что в кейсах написано. Значит, переименование ветки
 * — это массовая правка кейсов, а не правка отдельного справочника, который мог
 * бы разойтись с ними.
 */
export function buildSectionTree(cases: ProjectTestCase[]): SectionNode[] {
  const counts = new Map<string, number>();
  for (const item of cases) {
    const parts = (item.section ?? '').split('/').filter(Boolean);
    let prefix = '';
    for (const part of parts) {
      prefix = prefix ? `${prefix}/${part}` : part;
      counts.set(prefix, (counts.get(prefix) ?? 0) + 1);
    }
  }

  const roots: SectionNode[] = [];
  const byPath = new Map<string, SectionNode>();
  for (const path of [...counts.keys()].sort((a, b) => a.localeCompare(b))) {
    const parts = path.split('/');
    const node: SectionNode = {
      path,
      title: parts[parts.length - 1] ?? path,
      depth: parts.length - 1,
      count: counts.get(path) ?? 0,
      children: [],
    };
    byPath.set(path, node);
    const parent = byPath.get(parts.slice(0, -1).join('/'));
    if (parent) parent.children.push(node);
    else roots.push(node);
  }
  return roots;
}

/** Дерево в плоский список — так его рисуют отступами, без рекурсии в разметке. */
export function flattenSections(nodes: SectionNode[]): SectionNode[] {
  return nodes.flatMap((node) => [node, ...flattenSections(node.children)]);
}

/** Все кейсы всех групп с пометкой, откуда каждый, — основа общего списка. */
export interface CaseWithGroup {
  groupId: string;
  groupTitle: string;
  testCase: ProjectTestCase;
}

export function allCases(groups: ProjectTestGroup[], groupId?: string): CaseWithGroup[] {
  return groups
    .filter((group) => !groupId || group.id === groupId)
    .flatMap((group) =>
      group.cases.map((testCase) => ({
        groupId: group.id,
        groupTitle: group.title,
        testCase,
      })),
    );
}
