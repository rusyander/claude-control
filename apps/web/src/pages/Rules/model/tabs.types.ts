/**
 * Вкладки раздела «Правила» — отбор одного списка по вопросу, с которым
 * приходят: что агент видит сейчас и что лежит выключенным.
 * `id` попадает в адрес (`/rules?tab=…`).
 */
export const RULES_TABS = ['all', 'enabled', 'disabled'] as const;

export type RulesTabId = (typeof RULES_TABS)[number];
