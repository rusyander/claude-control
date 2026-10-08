import type { RunStatus } from '@shared/lib/agent-runs';
import type { ChatSummary } from '@agentdeck/contracts';

/** Точки в списке чатов: к живым прогонам добавляем ждущих из транскрипта. */
export function mergeAwaitingStatuses(
  statuses: ReadonlyMap<string, RunStatus>,
  awaiting: readonly ChatSummary[],
): Map<string, RunStatus> {
  const merged = new Map(statuses);
  for (const chat of awaiting) merged.set(chat.id, 'waiting');
  return merged;
}
