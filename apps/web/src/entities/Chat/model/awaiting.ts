import type { ChatSummary } from '@agentdeck/contracts';
import { isLive, type RunStatus } from '@shared/lib/agent-runs';

/**
 * Разговоры, где агент ждёт человека, а живого прогона за ними нет.
 *
 * Точки и звук раньше питались только от прогонов, запущенных самой панелью:
 * разговор в терминале или в соседнем окне не давал ни того, ни другого, и
 * вопрос лежал незамеченным. Признак `awaitingReply` приходит из транскрипта и
 * закрывает эту дыру, но чужим он становится только там, где своего сигнала
 * нет: прогон в памяти вкладки знает больше файла (он видит и запросы прав), и
 * два источника на один чат означали бы двойной звонок.
 */
export function selectAwaitingChats(
  chats: readonly ChatSummary[],
  statuses: ReadonlyMap<string, RunStatus>,
  /**
   * Ждущие по памяти сервера (вопросы и запросы прав деревьев). Пока ответа
   * нет — метка `awaitsYou` снимка списка; есть — он правдивее снимка: ответ
   * человека снимает вопрос сразу, а список перечитается лишь по событию.
   */
  server?: ReadonlySet<string>,
): ChatSummary[] {
  return chats.filter((chat) => {
    const asked = server ? server.has(chat.id) : Boolean(chat.awaitsYou);
    if (!chat.awaitingReply && !asked) return false;
    const live = statuses.get(chat.id);
    return live === undefined || (!isLive(live) && live !== 'waiting');
  });
}
