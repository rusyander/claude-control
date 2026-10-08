import type { ScriptMarks, ScriptsTabId } from './tabs.types';
import { scriptTab } from './tabs';

/** Скрипты открытой вкладки: «Все» — без отбора. */
export function scriptsInTab<T extends ScriptMarks>(scripts: readonly T[], tab: ScriptsTabId): T[] {
  return tab === 'all' ? [...scripts] : scripts.filter((script) => scriptTab(script) === tab);
}
