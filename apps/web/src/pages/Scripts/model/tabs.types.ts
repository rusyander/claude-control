export interface ScriptMarks {
  isUsed: boolean;
  isTest?: boolean;
}

/**
 * Вкладки раздела «Скрипты» — не разные заботы, а отбор одного списка по
 * вопросу, с которым приходят: что запускается, что забыто, что тесты.
 * `id` попадает в адрес (`/scripts?tab=…`).
 */
export const SCRIPTS_TABS = ['all', 'used', 'unused', 'test'] as const;

export type ScriptsTabId = (typeof SCRIPTS_TABS)[number];
