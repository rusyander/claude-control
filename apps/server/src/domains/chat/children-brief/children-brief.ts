import { WORKSPACE_TAG } from '../workspace-note/workspace-note.ts';

/**
 * Сводка детей для хода родителя (Д6) и сводка лёгкого чата о ходе групп (5.1)
 * сняты вместе с конвейером разделения панели (этап 10, G14): писать их некому.
 * Остаётся снятие: прежняя версия клала сводку В СООБЩЕНИЕ, обёрнутой в тег, —
 * в транскриптах и в параметрах остановленного прогона она живёт и сейчас.
 * Ленте человека её не показывают (`stripChildrenBrief`), а продолжение со
 * старыми параметрами не повторяет её модели (`withoutChildrenBrief`).
 */
const TAG = 'agentdeck-children';
const BLOCK = new RegExp(`^\\s*<${TAG}>[\\s\\S]*?</${TAG}>\\s*`);
const ANY_BLOCK = new RegExp(`<${TAG}>[\\s\\S]*?</${TAG}>\\s*`, 'g');
const WORKSPACE_BLOCK = new RegExp(`<${WORKSPACE_TAG}>[\\s\\S]*?</${WORKSPACE_TAG}>\\s*`, 'g');

/**
 * Промпт хода без прежней сводки в начале: продолжение после паузы дерева
 * приходит с параметрами, записанными прежней версией.
 */
export function withoutChildrenBrief(prompt: string): string {
  return prompt.replace(BLOCK, '');
}

/**
 * Текст реплики без блоков панели — то, что человек на самом деле написал: без
 * сводки детей и без перемены строки о тестах (`workspace-note.ts`).
 */
export function stripChildrenBrief(text: string): string {
  const own = text.includes(`<${TAG}>`) ? text.replace(ANY_BLOCK, '') : text;
  return own.includes(`<${WORKSPACE_TAG}>`) ? own.replace(WORKSPACE_BLOCK, '') : own;
}
