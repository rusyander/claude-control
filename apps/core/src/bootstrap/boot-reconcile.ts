import { openActions } from '../conductor/outbox.ts';
import {
  reconcileSessions,
  type HostLiveness,
  type SessionVerdict,
} from '../conductor/process-reconcile.ts';
import {
  reconcileTask,
  type ActionFactReaders,
  type ReconcileDecision,
} from '../conductor/reconcile.ts';
import type { TaskRegistry } from '../conductor/tasks.ts';

/**
 * Сверка прежнего ядра: при загрузке и потом по таймеру, пока не решено (01 §Outbox, P86, P12).
 *
 * - Набор берётся ОДИН раз при загрузке: действия и сессии, открытые до неё. Действие, начатое
 *   этим ядром, таймер не трогает никогда — его эффект может идти прямо сейчас.
 * - `retry` (факт `unknown`) и `wait` (живость хоста не прочитана) остаются в наборе: таймер
 *   спрашивает снова, срок повтора — от первой записанной сверки, так что вопрос человеку
 *   (`ask`, пункт 4) задаётся и без перезапуска (ревью F-26). Хост, умерший позже, — `lost`.
 * - Хост жив (`reattach`): прикрепление сессии к рантайму — дело запускателя (сейчас его нет в
 *   загрузке); до него сессия проверяется на смерть тем же таймером (ревью F-51).
 * - Сбой сверки одной задачи (журнал не пишется) не роняет загрузку и не трогает другие: задача
 *   помечается «нужен человек», таймер пробует её снова (ревью F-49).
 */

export const RECONCILE_EVERY_MS = 30_000;

export interface BootReconcileDeps {
  registry: TaskRegistry;
  readers: ActionFactReaders;
  isAlive(id: { pid: number; start: string }): Promise<HostLiveness>;
  note(event: string, data: Record<string, unknown>): void;
  now(): number;
}

interface Pending {
  actions: Set<string>;
  sessions: Set<string>;
}

const OPEN_SESSION = new Set(['starting', 'live', 'quiet']);

export interface BootReconcile {
  /** Сверка открытых при загрузке задач; ни одна задача её не роняет. */
  atBoot(taskIds: readonly string[]): Promise<void>;
  /** Таймер повторной сверки; ответ — остановка, ждущая идущий проход. */
  start(everyMs: number): () => Promise<void>;
  /** Что ещё не решено: задача → число действий и сессий. */
  pending(): Record<string, { actions: number; sessions: number }>;
}

export function createBootReconcile(deps: BootReconcileDeps): BootReconcile {
  const firstAsked = new Map<string, number>();
  const pending = new Map<string, Pending>();

  const settle = (
    taskId: string,
    decisions: ReconcileDecision[],
    sessions: SessionVerdict[],
  ): void => {
    const next: Pending = {
      actions: new Set(decisions.filter((d) => d.verdict === 'retry').map((d) => d.actionId)),
      sessions: new Set(sessions.filter((s) => s.action !== 'lost').map((s) => s.sessionId)),
    };
    if (next.actions.size || next.sessions.size) pending.set(taskId, next);
    else pending.delete(taskId);
  };

  const once = async (taskId: string, only: Pending, first: boolean): Promise<void> => {
    const task = deps.registry.live(taskId);
    if (!task) {
      // Задача ушла из живых (аренду перехватили): её сверит новый владелец.
      pending.delete(taskId);
      return;
    }
    try {
      const sessions = await reconcileSessions(task, deps.isAlive, only.sessions);
      const decisions = await reconcileTask(
        task,
        deps.readers,
        { now: deps.now },
        firstAsked,
        only.actions,
      );
      settle(taskId, decisions, sessions);
      // Таймер пишет в журнал ядра только перемены, не каждый повтор.
      const moved =
        decisions.some((d) => d.verdict !== 'retry') || sessions.some((s) => s.action === 'lost');
      if (first ? decisions.length > 0 || sessions.length > 0 : moved) {
        deps.note('reconcile', { taskId, decisions, sessions });
      }
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      deps.registry.flag(taskId, `reconcile failed: ${reason}`);
      deps.note('reconcile.failed', { taskId, reason });
      pending.set(taskId, only);
    }
  };

  return {
    async atBoot(taskIds) {
      for (const taskId of taskIds) {
        const task = deps.registry.live(taskId);
        if (!task) continue;
        const only: Pending = {
          actions: new Set(openActions(task).map((a) => a.actionId)),
          sessions: new Set(
            Object.entries(task.state.sessions)
              .filter(([, s]) => OPEN_SESSION.has(s.state))
              .map(([id]) => id),
          ),
        };
        await once(taskId, only, true);
      }
    },
    start(everyMs) {
      let running: Promise<void> | undefined;
      let stopped = false;
      const tick = (): void => {
        if (running || stopped || pending.size === 0) return;
        running = (async () => {
          for (const [taskId, only] of [...pending]) {
            if (stopped) return;
            await once(taskId, only, false);
          }
        })().finally(() => {
          running = undefined;
        });
      };
      const timer = setInterval(tick, everyMs);
      timer.unref?.();
      return async () => {
        stopped = true;
        clearInterval(timer);
        await running;
      };
    },
    pending() {
      return Object.fromEntries(
        [...pending].map(([taskId, p]) => [
          taskId,
          { actions: p.actions.size, sessions: p.sessions.size },
        ]),
      );
    },
  };
}
