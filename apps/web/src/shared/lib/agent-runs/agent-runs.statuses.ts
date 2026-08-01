import { normalizeProjectPath } from '@shared/lib/workspace';
import { emit, runs } from './agent-runs.state';
import { selectActiveRuns, type ActiveRunView } from './selectors';
import { aggregateStatus, runStatus, type RunStatus } from './status';

/**
 * Своды по прогонам: статус проекта (точка на табе), статус разговора (точка в
 * списке чатов) и лента активных прогонов для пульта. Снимки кэшируются и
 * пересобираются только при смене статуса или по таймеру зависания, а не на
 * каждый токен текста, иначе лента табов перерисовывалась бы на каждую букву.
 */

let statusSnapshot = new Map<string, RunStatus>();
/**
 * Статус по КОНКРЕТНОМУ разговору — точка в списке чатов. Табам хватает свода по
 * проекту, но в одном проекте разговоров несколько, и агент в каждом свой:
 * без этой карты видно «в проекте кто-то ждёт», а в котором именно — нет.
 */
let chatStatusSnapshot = new Map<string, RunStatus>();
let activeRunsSnapshot: ActiveRunView[] = [];
let watchdog: ReturnType<typeof setInterval> | undefined;

/** Пересобрать снимок статусов по проектам (с поправкой на зависание). */
export function rebuildStatuses(): void {
  const now = Date.now();
  const byProject = new Map<string, RunStatus[]>();
  const byChat = new Map<string, RunStatus>();

  for (const run of runs.values()) {
    const status = runStatus({
      status: run.status,
      lastEventAt: run.lastEventAt,
      now,
      pendingPermission: run.permissions.length > 0,
    });

    // Разговор в списке чатов опознаётся по sessionId, а прогон мог стартовать
    // под временным `new-…` — кладём обе ссылки, чтобы точка нашлась в любом
    // случае. Завершённые (idle) в карту не идут: точки у них нет.
    if (status !== 'idle') {
      byChat.set(run.id, status);
      if (run.sessionId) byChat.set(run.sessionId, status);
    }

    if (!run.projectPath) continue;
    const key = normalizeProjectPath(run.projectPath);
    const list = byProject.get(key) ?? [];
    list.push(status);
    byProject.set(key, list);
  }

  const next = new Map<string, RunStatus>();
  for (const [key, list] of byProject) next.set(key, aggregateStatus(list));
  statusSnapshot = next;
  chatStatusSnapshot = byChat;

  // Пульт агентов и счётчик работают из того же снимка.
  activeRunsSnapshot = selectActiveRuns([...runs.values()], now);
}

/** Таймер зависания: раз в 20 c пересобираем статусы, чтобы «молчащий» стал красным. */
export function ensureWatchdog(): void {
  if (watchdog || typeof window === 'undefined') return;
  watchdog = setInterval(() => {
    let hasRunning = false;
    for (const run of runs.values()) if (run.status === 'running') hasRunning = true;
    if (!hasRunning) return;
    rebuildStatuses();
    emit();
  }, 20_000);
}

export function getProjectStatuses(): Map<string, RunStatus> {
  return statusSnapshot;
}

/** Карта «id разговора → статус его агента» — точки в списке чатов. */
export function getChatStatuses(): Map<string, RunStatus> {
  return chatStatusSnapshot;
}

export function getActiveRuns(): ActiveRunView[] {
  return activeRunsSnapshot;
}
