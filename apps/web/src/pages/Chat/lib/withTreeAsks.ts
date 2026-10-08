import type { ChildQuestion, ChildPermission } from '@features/ChatMessages';
import type { ChatTreeView } from '@agentdeck/contracts/chat-handoff';
import type { ChatSummary } from '@agentdeck/contracts';
import { mergeQuestions } from './mergeQuestions';
import { mergePermissions } from './mergePermissions';
import { collectTreeAsks } from './treeAsks';

/**
 * Вопросы и права хаба целиком: живые из потоков вкладки плюс записанные
 * сервером — у отцепленной группы потока нет, и без второго источника её
 * вопрос не доходил до человека вовсе.
 */
export function withTreeAsks(
  live: { questions: ChildQuestion[]; permissions: ChildPermission[] },
  tree: ChatTreeView | undefined,
  parentChatId: string | undefined,
  chats: ChatSummary[],
): { questions: ChildQuestion[]; permissions: ChildPermission[] } {
  const server = collectTreeAsks(tree, parentChatId, chats);
  return {
    questions: mergeQuestions(live.questions, server.questions),
    permissions: mergePermissions(live.permissions, server.permissions),
  };
}
