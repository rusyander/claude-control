import type { RulesTabId } from './tabs.types';
import { rulesInTab } from './tabs';

/**
 * Что показывать на вкладке: её отбор ПЛЮС правила, переключённые на ней же.
 *
 * Отбор идёт по живым данным, и правило, выключенное на «Включены», исчезало
 * из-под пальца в момент щелчка — ни проверить, что щёлкнул то, ни вернуть
 * переключатель назад. Переключённое остаётся на месте до смены вкладки; порядок
 * — исходный порядок списка, чтобы карточка не прыгала.
 */
export function rulesShownInTab<T extends { id: string; isEnabled: boolean }>(
  rules: readonly T[],
  tab: RulesTabId,
  kept: ReadonlySet<string>,
): T[] {
  if (tab === 'all' || kept.size === 0) return rulesInTab(rules, tab);
  const wantEnabled = tab === 'enabled';
  return rules.filter((rule) => rule.isEnabled === wantEnabled || kept.has(rule.id));
}
