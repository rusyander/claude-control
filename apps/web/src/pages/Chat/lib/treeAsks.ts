import type { ChatSummary } from '@agentdeck/contracts';
import type { ChatTreeNode, ChatTreeView } from '@agentdeck/contracts/chat-handoff';
import type { ChildPermission, ChildQuestion } from '@features/ChatMessages';

/**
 * Вопросы и запросы прав разговоров дерева — из записи СЕРВЕРА (WP9c).
 *
 * Поток прогона видит только вкладка, которая к нему подключена. Группу,
 * запущенную конвейером, продолжением или перезапуском панели, никто не
 * смотрит, и её вопрос не доходил до хаба вовсе, а подсмотренный — пропадал
 * на F5 (журнал 30, 36, 62). Сервер записывает их сам и отдаёт в дереве
 * разговоров; хаб опрашивает дерево каждые пять секунд.
 *
 * Берутся только потомки открытого разговора: дерево приходит от КОРНЯ, и
 * разговор середины дерева иначе показал бы вопросы соседей.
 */
export function collectTreeAsks(
  tree: ChatTreeView | undefined,
  parentChatId: string | undefined,
  chats: ChatSummary[],
): { questions: ChildQuestion[]; permissions: ChildPermission[] } {
  const questions: ChildQuestion[] = [];
  const permissions: ChildPermission[] = [];
  if (!tree || !parentChatId) return { questions, permissions };

  for (const node of descendants(tree, parentChatId)) {
    const keys = [node.chatId, ...node.aliases];
    const chat = chats.find((item) => keys.includes(item.id));
    // Отброшенный перезапуском разделения чат (L20) не спрашивает: его работа
    // не продолжается, и ответ ушёл бы в никуда.
    if (chat?.retired) continue;
    const title = node.title || chat?.title || node.chatId;
    const byRun = new Map<string, ChildPermission>();
    for (const ask of node.asks ?? []) {
      if (ask.kind === 'permission' && ask.toolUseId) {
        const entry = byRun.get(ask.runId) ?? { chatId: ask.runId, title, permissions: [] };
        entry.permissions.push({
          toolName: ask.toolName ?? '',
          input: ask.input,
          toolUseId: ask.toolUseId,
        });
        byRun.set(ask.runId, entry);
        continue;
      }
      // Ответ уходит в ЧАТ ребёнка под ключом, под которым его знает список:
      // временный ключ прогона после перезапуска не найти.
      const common = { chatId: node.chatId, title, isRunning: node.running };
      if (ask.kind === 'question' && ask.input !== undefined) {
        questions.push({
          ...common,
          input: typeof ask.input === 'string' ? ask.input : JSON.stringify(ask.input),
          ...(ask.toolUseId ? { toolUseId: ask.toolUseId } : {}),
        });
      }
      if (ask.kind === 'text' && ask.text) {
        questions.push({ ...common, input: '', text: ask.text });
      }
    }
    permissions.push(...byRun.values());
  }
  return { questions, permissions };
}

/** Потомки разговора в дереве — по `parentChatId` узлов и их псевдонимам. */
function descendants(tree: ChatTreeView, chatId: string): ChatTreeNode[] {
  const inside = new Set<string>([chatId]);
  const out: ChatTreeNode[] = [];
  let grew = true;
  while (grew) {
    grew = false;
    for (const node of tree.nodes) {
      if (out.includes(node) || !node.parentChatId || !inside.has(node.parentChatId)) continue;
      out.push(node);
      for (const key of [node.chatId, ...node.aliases]) inside.add(key);
      grew = true;
    }
  }
  return out;
}
