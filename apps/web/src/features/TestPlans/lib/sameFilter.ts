import type { ProjectTestPlan } from '@agentdeck/contracts';

/**
 * Совпадает ли сохранённый набор с тем, что уже стоит в плане.
 *
 * Сравниваются сами условия, а не ссылка на набор: план хранит РЕЗУЛЬТАТ выбора
 * («вот такой фильтр»), а не идентификатор набора — иначе удаление набора
 * ломало бы состав плана задним числом.
 */
export function sameFilter(
  left: ProjectTestPlan['filter'],
  right: ProjectTestPlan['filter'],
): boolean {
  if (!left || !right) return false;
  return JSON.stringify(left) === JSON.stringify(right);
}
