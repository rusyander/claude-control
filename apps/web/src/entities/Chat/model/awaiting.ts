import type { ChatSummary } from '@claude-control/contracts';
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
): ChatSummary[] {
  return chats.filter((chat) => {
    if (!chat.awaitingReply) return false;
    const live = statuses.get(chat.id);
    return live === undefined || (!isLive(live) && live !== 'waiting');
  });
}

/** Точки в списке чатов: к живым прогонам добавляем ждущих из транскрипта. */
export function mergeAwaitingStatuses(
  statuses: ReadonlyMap<string, RunStatus>,
  awaiting: readonly ChatSummary[],
): Map<string, RunStatus> {
  const merged = new Map(statuses);
  for (const chat of awaiting) merged.set(chat.id, 'waiting');
  return merged;
}

/**
 * Точки на табах проектов. Красная перекрывает жёлтую: упавший агент важнее
 * ждущего вопроса, и понижать уже зажжённую тревогу нельзя.
 */
export function mergeAwaitingProjectStatuses(
  statuses: ReadonlyMap<string, RunStatus>,
  awaiting: readonly ChatSummary[],
): Map<string, RunStatus> {
  const merged = new Map(statuses);
  for (const chat of awaiting) {
    if (!chat.projectPath) continue;
    if (merged.get(chat.projectPath) === 'error') continue;
    merged.set(chat.projectPath, 'waiting');
  }
  return merged;
}
