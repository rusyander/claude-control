import type { TaskFoldState } from '../../journal/reduce/reduce.types.ts';
import type { LiveTask } from '../../journal/resume.ts';
import * as hook from './hooks.ts';
import type { ConductorHooks } from './run.types.ts';

/**
 * Конец задачи — один путь, кто бы её ни кончил (00 §Words: итоговый отчёт — сообщение конца
 * задачи): дирижёр (`finishTask`), отмена человеком в любом состоянии (и до запуска, где
 * исполнителя нет), отказ оценки в самом создании, крах ядра между концом и закрытием. Сессии
 * задачи снимает вызывающий — у исполнителя это его живые сессии, у обхода без исполнителя —
 * открытые по журналу; затем крючки конца зон (уход за вопросами, уборка, отчёт E).
 */

export interface TaskClose {
  hooks: readonly ConductorHooks[];
  stopSessions(): Promise<void>;
  note?(event: string, data: Record<string, unknown>): void;
}

/**
 * Конец не закрыт: задача кончилась, а отчёта конца в журнале нет. Отчёт пишется последним и
 * ровно раз на точку, поэтому это то же суждение и для исполнителя, и для обхода, и для загрузки
 * после краха — повтор перезапуска закрытую задачу не трогает.
 */
export function endUnclosed(state: Pick<TaskFoldState, 'ended' | 'report'>): boolean {
  return state.ended !== null && state.report?.at !== 'ended';
}

export async function closeTask(task: LiveTask, close: TaskClose): Promise<void> {
  try {
    await close.stopSessions();
    await hook.taskEnd(close.hooks, task.taskId, 'ended');
  } catch (err) {
    close.note?.('task-end.failed', { ended: task.state.ended, error: String(err) });
  }
}
