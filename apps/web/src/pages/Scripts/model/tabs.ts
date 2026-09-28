import type { IconName } from '@shared/ui/icon';

/**
 * Вкладки раздела «Скрипты» — не разные заботы, а отбор одного списка по
 * вопросу, с которым приходят: что запускается, что забыто, что тесты.
 * `id` попадает в адрес (`/scripts?tab=…`).
 */
export const SCRIPTS_TABS = ['all', 'used', 'unused', 'test'] as const;

export type ScriptsTabId = (typeof SCRIPTS_TABS)[number];

export const SCRIPTS_TAB_ICONS: Record<ScriptsTabId, IconName> = {
  all: 'scripts',
  used: 'hooks',
  unused: 'flag',
  test: 'check',
};

interface ScriptMarks {
  isUsed: boolean;
  isTest?: boolean;
}

/**
 * Вкладка-отбор, в которую попадает скрипт, кроме «Все». Порядок тот же, что у
 * отметки в строке: привязанный тест — прежде всего привязанный (его удаление
 * ломает хук), поэтому каждый файл лежит ровно в одной из трёх вкладок и их
 * счётчики в сумме дают «Все».
 */
export function scriptTab(script: ScriptMarks): Exclude<ScriptsTabId, 'all'> {
  if (script.isUsed) return 'used';
  if (script.isTest) return 'test';
  return 'unused';
}

/** Скрипты открытой вкладки: «Все» — без отбора. */
export function scriptsInTab<T extends ScriptMarks>(scripts: readonly T[], tab: ScriptsTabId): T[] {
  return tab === 'all' ? [...scripts] : scripts.filter((script) => scriptTab(script) === tab);
}
