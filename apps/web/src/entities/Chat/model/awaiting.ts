import type { ChatSummary } from '@agentdeck/contracts';
import { aggregateStatus, isLive, type RunStatus } from '@shared/lib/agent-runs';
import { normalizeProjectPath } from '@shared/lib/workspace';

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
 *
 * Ключ — НОРМАЛИЗОВАННЫЙ путь, как у id вкладки. Сырой `C:\work\app` из
 * транскрипта с `c:/work/app` вкладки не совпадал никогда, и на Windows точка
 * «ждёт ответа» на вкладку не попадала вовсе. Разговор в git-копии зажигает и
 * вкладку основной копии: копию как вкладку обычно никто не открывает.
 */
export function mergeAwaitingProjectStatuses(
  statuses: ReadonlyMap<string, RunStatus>,
  awaiting: readonly ChatSummary[],
): Map<string, RunStatus> {
  const merged = new Map(statuses);
  for (const chat of awaiting) {
    for (const path of [chat.projectPath, chat.homeProjectPath]) {
      if (!path) continue;
      const key = normalizeProjectPath(path);
      if (merged.get(key) === 'error') continue;
      merged.set(key, 'waiting');
    }
  }
  return merged;
}

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
