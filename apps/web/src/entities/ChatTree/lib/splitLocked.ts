import { splitPlanRunning, type ChatTreeView } from '@agentdeck/contracts/chat-handoff';

/**
 * Кнопка «Разделить» заперта: запрос ещё идёт ИЛИ разделение ЭТОГО разговора
 * уже работает (находка 12 живого прогона 24.09.2026).
 *
 * При разборе ответ маршрута приходит без чатов (`chats: []`): копии заведёт
 * конвейер позже. Карточка по веткам детей отработанной себя не считала, кнопка
 * оживала, и второе нажатие заводило второй разбор поверх плана. Теперь её
 * держит запись конвейера из дерева — та же, по которой сервер отвечает 409.
 *
 * Дерево поднимается к корню от любого разговора, поэтому сверяем родителя
 * записи с этим чатом: чужое разделение (корня, соседа) кнопку не держит.
 */
export function splitLocked(
  pending: boolean,
  tree: ChatTreeView | undefined,
  chatKey: string | undefined,
): boolean {
  if (pending) return true;
  const split = tree?.split;
  if (!split || !chatKey || split.parentChatId !== chatKey) return false;
  return splitPlanRunning(split.groups);
}
