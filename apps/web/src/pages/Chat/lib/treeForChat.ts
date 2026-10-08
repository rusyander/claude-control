import type { ChatTreeView } from '@agentdeck/contracts/chat-handoff';

/**
 * Дерево, каким его видит хаб ЭТОГО разговора. Сервер отдаёт дерево по корню,
 * и в чате группы приезжал план всего разделения: хаб звена рисовал все группы
 * «ждёт итога разбора» и кнопки «Остановить всё / Отменить план» чужого плана
 * (живой прогон 26.09, F2). План принадлежит разговору, который его завёл.
 */
export function treeForChat(
  tree: ChatTreeView | undefined,
  chatId: string | undefined,
): ChatTreeView | undefined {
  if (!tree?.split || tree.split.parentChatId === chatId) return tree;
  const own = { ...tree };
  delete own.split;
  return own;
}
