import type { RunStatus } from '@shared/lib/agent-runs';
import type { ChatSummary } from '@agentdeck/contracts';
import { normalizeProjectPath } from '@shared/lib/workspace';

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
