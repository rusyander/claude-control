import { isLive, runStatus, type RunStatus } from './status';
import type { PendingPermission, StreamedTool } from './agent-runs.types';

/**
 * Чистые выборки поверх прогонов — для пульта агентов и суммарной стоимости.
 * Работают со структурной формой прогона (не завязаны на класс стора), поэтому
 * легко тестируются отдельно.
 */

export interface RunLike {
  id: string;
  sessionId?: string;
  projectPath?: string;
  status: RunStatus;
  lastEventAt: number;
  costUsd?: number;
  tokens?: number;
  /** Запросы прав, ждущие ответа — влияют на статус (жёлтая точка). */
  permissions?: PendingPermission[];
  /** Вызовы этого хода: среди них и вопрос человеку. */
  tools?: StreamedTool[];
}

export interface ActiveRunView {
  id: string;
  sessionId?: string;
  projectPath?: string;
  /** Статус с поправкой на зависание; idle сюда не попадает. */
  status: Exclude<RunStatus, 'idle'>;
  costUsd?: number;
  tokens?: number;
  /**
   * Вызовы прогона. Нужны не только его собственной ленте: вопрос дочернего
   * чата (`AskUserQuestion`) показывается и в РОДИТЕЛЬСКОМ разговоре, чтобы
   * человек отвечал всем из одного места, а не обходил шесть чатов по кругу.
   */
  tools?: StreamedTool[];
}

/**
 * Активные прогоны — те, у кого есть что показать точкой: работает, молчит,
 * ждёт ответа или упал. Завершённые (idle) отсеиваем. Порядок по тревожности:
 * сначала ошибки, потом ждущие, потом молчащие, потом работающие.
 */
export function selectActiveRuns(runs: RunLike[], now: number): ActiveRunView[] {
  const active: ActiveRunView[] = [];
  for (const run of runs) {
    const status = runStatus({
      status: run.status,
      lastEventAt: run.lastEventAt,
      now,
      pendingPermission: (run.permissions?.length ?? 0) > 0,
    });
    if (status === 'idle') continue;
    active.push({
      id: run.id,
      sessionId: run.sessionId,
      projectPath: run.projectPath,
      status,
      costUsd: run.costUsd,
      tokens: run.tokens,
      // Вопросы носим только у тех, кто спрашивал: у остальных это лишний
      // массив на каждый пересчёт пульта агентов.
      ...(run.tools?.some((tool) => tool.name === 'AskUserQuestion') ? { tools: run.tools } : {}),
    });
  }

  const order: Record<Exclude<RunStatus, 'idle'>, number> = {
    error: 0,
    waiting: 1,
    quiet: 2,
    running: 3,
  };
  return active.sort((a, b) => order[a.status] - order[b.status]);
}

/**
 * Сколько активных прогонов сейчас работает (для бейджа-счётчика). Молчащий —
 * тоже работает: процесс жив, просто событий давно не было.
 */
export function countRunning(runs: RunLike[], now: number): number {
  return runs.filter((run) =>
    isLive(
      runStatus({
        status: run.status,
        lastEventAt: run.lastEventAt,
        now,
        pendingPermission: (run.permissions?.length ?? 0) > 0,
      }),
    ),
  ).length;
}
