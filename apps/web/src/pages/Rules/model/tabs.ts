import type { IconName } from '@shared/ui/icon';

/**
 * Вкладки раздела «Правила» — отбор одного списка по вопросу, с которым
 * приходят: что агент видит сейчас и что лежит выключенным.
 * `id` попадает в адрес (`/rules?tab=…`).
 */
export const RULES_TABS = ['all', 'enabled', 'disabled'] as const;

export type RulesTabId = (typeof RULES_TABS)[number];

export const RULES_TAB_ICONS: Record<RulesTabId, IconName> = {
  all: 'rules',
  enabled: 'eye',
  disabled: 'eyeOff',
};

/** Правила открытой вкладки: «Все» — без отбора. */
export function rulesInTab<T extends { isEnabled: boolean }>(
  rules: readonly T[],
  tab: RulesTabId,
): T[] {
  if (tab === 'all') return [...rules];
  const wantEnabled = tab === 'enabled';
  return rules.filter((rule) => rule.isEnabled === wantEnabled);
}

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
