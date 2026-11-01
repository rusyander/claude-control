import type { AdapterEvent } from '../../adapters/index.ts';
import type { SessionBinding } from '../../conductor/model-tools/model-tools.types.ts';
import { windowKey } from '../../journal/reduce/stage5.ts';
import type { LiveTask } from '../../journal/resume.ts';
import { decideWindow, type WindowBook } from '../../economy/window/index.ts';

/**
 * Факт окна из потока сессии (план s5 зона L, G7): наблюдение уходит в книгу окон ядра (общую
 * для всех задач на маршруте), а в журнал задачи `window.state` пишется, только когда вердикт
 * пары «маршрут × вид» для неё сменился — повтор того же замера журнал не раздувает.
 */

type WindowEvent = Extract<AdapterEvent, { type: 'window' }>;

/** `true` — вердикт задачи сменился и записан. */
export function journalWindow(
  task: LiveTask,
  binding: SessionBinding,
  event: WindowEvent,
  book: WindowBook,
  now: number,
): boolean {
  const session = Object.hasOwn(task.state.sessions, binding.sessionId)
    ? task.state.sessions[binding.sessionId]
    : undefined;
  if (!session) return false;
  const routeId = session.route.id;
  book.observe({
    routeId,
    limitKind: event.limitKind,
    usedPct: event.usedPct,
    resetAt: event.resetAt,
    refusal: event.refusal,
    warning: event.warning,
    source: 'cli-event',
    at: now,
  });
  const d = decideWindow(book.all(), routeId, event.limitKind, now);
  const key = windowKey(routeId, event.limitKind);
  const was = Object.hasOwn(task.state.windows, key) ? task.state.windows[key] : undefined;
  // Сброс в строке — тот, с которого маршрут снова откроется; у открытого — сброс источника.
  const resetAt = d.resumeAt ?? event.resetAt;
  if (was && was.verdict === d.verdict && was.resetAt === resetAt) return false;
  task.append({
    kind: 'window.state',
    actor: `adapter:${session.adapter}`,
    sessionId: binding.sessionId,
    data: { routeId, limitKind: event.limitKind, verdict: d.verdict, resetAt },
  });
  return true;
}
