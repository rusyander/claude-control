import type { RunStatus } from '@shared/lib/agent-runs';
import type { ChatSummary } from '@agentdeck/contracts';
import { normalizeProjectPath } from '@shared/lib/workspace';
import { aggregateStatus } from '@shared/lib/agent-runs';

/**
 * Статус прогона в git-копии поднимается на вкладку основной копии.
 *
 * Прогон числится за своим каталогом, а чат, который «первая правка» увела в
 * копию, идёт именно там — и вкладка проекта оставалась без точки, пока агент
 * работал в нём полчаса. Какая копия чья, знает список чатов (`homeProjectPath`).
 */
export function foldCopyStatuses(
  statuses: ReadonlyMap<string, RunStatus>,
  chats: readonly ChatSummary[],
): Map<string, RunStatus> {
  const merged = new Map(statuses);
  const homes = new Map<string, string>();
  for (const chat of chats) {
    if (chat.projectPath && chat.homeProjectPath)
      homes.set(normalizeProjectPath(chat.projectPath), normalizeProjectPath(chat.homeProjectPath));
  }
  for (const [copy, home] of homes) {
    const status = statuses.get(copy);
    if (!status) continue;
    merged.set(home, aggregateStatus([merged.get(home) ?? 'idle', status]));
  }
  return merged;
}
