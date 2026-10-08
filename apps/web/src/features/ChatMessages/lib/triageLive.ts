import type { ChildStageGroup } from '../ui/ChildStages.types';
import type { ChatTreeView } from '@agentdeck/contracts/chat-handoff';
import { isTriageRow } from './hubSummary';

/**
 * Идёт ли прогон разбора прямо сейчас: строка разбора в хабе или его узел в
 * дереве сервера. Дерево нужно, потому что строки разбора может и не быть (чат
 * ещё не доехал до списка, лента чужого CLI), а знать, идёт ли он, фишке надо
 * всегда: «идёт разбор» над стоящим деревом — та же ложь, что «в работе» (L23).
 */
export function triageLive(groups: ChildStageGroup[], tree: ChatTreeView | undefined): boolean {
  if (groups.some((group) => !group.retired && isTriageRow(group) && group.isRunning)) return true;
  const triageChatId = tree?.split?.triageChatId;
  if (!triageChatId) return false;
  return (tree?.nodes ?? []).some(
    (node) => node.running && (node.chatId === triageChatId || node.aliases.includes(triageChatId)),
  );
}
