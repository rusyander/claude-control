import { stopSession } from '../../adapters/launcher/session-io.ts';
import { closeTask, endUnclosed } from '../../conductor/run/close.ts';
import type { ConductorHooks } from '../../conductor/run/run.types.ts';
import type { LiveTask } from '../../journal/resume.ts';
import { journaledSessionDir } from './session-start.ts';

/**
 * Конец задачи без исполнителя (зона B): отмена черновика или ждущей запуска задачи, отказ оценки
 * в самом создании, задача, которую крах ядра оставил кончившейся без отчёта (загрузка открывает
 * её снова — `openUnfinished`). Путь конца тот же, что у исполнителя (`closeTask`); сессии берутся
 * из журнала — живых в памяти у этого ядра нет — и снимаются деревом.
 */

export const OPEN_SESSION = new Set(['starting', 'live', 'quiet']);

export interface EndCloser {
  /** Закрыть кончившуюся задачу без исполнителя: ровно раз, и только если конец не закрыт. */
  close(task: LiveTask): Promise<void>;
  /** Конец этой задачи закрывает её исполнитель (`closeEnded` в `stop('end')`): обход не повторяет. */
  claim(taskId: string): void;
}

export function createEndCloser(deps: {
  hooks: readonly ConductorHooks[];
  note(event: string, data: Record<string, unknown>): void;
}): EndCloser {
  const done = new Set<string>();

  const stopJournaled = async (task: LiveTask): Promise<void> => {
    for (const [sessionId, session] of Object.entries(task.state.sessions)) {
      if (!OPEN_SESSION.has(session.state)) continue;
      try {
        const stopped = await stopSession(journaledSessionDir(task, sessionId), 'tree');
        deps.note('loop.end-session-stopped', { taskId: task.taskId, sessionId, how: stopped.how });
      } catch (error) {
        // Несдавшаяся сессия названа, но отчёт конца не держит: иначе задача осталась бы без
        // него навсегда — каждая загрузка спотыкалась бы о ту же сессию.
        deps.note('loop.end-session-unstopped', {
          taskId: task.taskId,
          sessionId,
          reason: String(error),
        });
        continue;
      }
      const now = task.state.sessions[sessionId]?.state ?? '';
      if (!OPEN_SESSION.has(now)) continue;
      task.append({
        kind: 'session.transition',
        actor: 'core',
        sessionId,
        data: { sessionId, event: 'exited', from: now as never, to: 'ended' },
      });
    }
  };

  return {
    async close(task) {
      if (done.has(task.taskId) || !endUnclosed(task.state)) return;
      done.add(task.taskId);
      deps.note('loop.end-closed', { taskId: task.taskId, ended: task.state.ended });
      await closeTask(task, {
        hooks: deps.hooks,
        note: (event, data) => deps.note(event, { taskId: task.taskId, ...data }),
        stopSessions: () => stopJournaled(task),
      });
    },
    claim(taskId) {
      done.add(taskId);
    },
  };
}
