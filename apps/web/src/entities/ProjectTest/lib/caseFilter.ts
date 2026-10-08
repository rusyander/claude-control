import type { ProjectTestCase, ProjectTestFilter } from '@agentdeck/contracts';
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
  if (filter.muted !== undefined && (testCase.muted === true) !== filter.muted) return false;
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
