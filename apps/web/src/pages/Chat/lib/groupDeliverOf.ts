import type { ChatTreeView } from '@agentdeck/contracts/chat-handoff';
import type { ChatSummary } from '@agentdeck/contracts';

/**
 * Решение «До MR» группы, принятое при разделении, — для шапки её чата. Путь
 * копии даёт настройку проекта, а она расходится с планом, запущенным с другим
 * выбором (живой прогон 25.09, O2). Не группа или план не её родителя — нет.
 */
export function groupDeliverOf(
  tree: ChatTreeView | undefined,
  chat: Pick<ChatSummary, 'parentId' | 'groupIndex'> | undefined,
): boolean | undefined {
  const split = tree?.split;
  if (!split || !chat?.parentId || chat.groupIndex === undefined) return undefined;
  if (split.parentChatId !== chat.parentId) return undefined;
  return split.groups.find((group) => group.index === chat.groupIndex)?.deliver;
}
