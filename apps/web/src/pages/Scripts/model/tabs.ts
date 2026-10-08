import type { IconName } from '@shared/ui/icon';
import type { ScriptMarks, ScriptsTabId } from './tabs.types';

export const SCRIPTS_TAB_ICONS: Record<ScriptsTabId, IconName> = {
  all: 'scripts',
  used: 'hooks',
  unused: 'flag',
  test: 'check',
};

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
