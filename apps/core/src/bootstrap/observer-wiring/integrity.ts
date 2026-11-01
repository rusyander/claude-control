import type { LiveTask } from '../../journal/resume.ts';
import { newId } from '../../lib/ids/uuidv7.ts';
import { signalDef } from '../../observer/catalog.ts';
import {
  journalRejectedVerdict,
  type JournalRejection,
} from '../../observer/integrity/journal-rejected.ts';
import { judgeSignal } from '../../observer/judge.ts';
import type { SignalDef } from '../../observer/observer.types.ts';
import type { ObserverNote } from './observer-wiring.types.ts';
import { writeObserverDecision } from './write.ts';

/**
 * Отказ писателя журнала → сигнал `journal-rejected` (этап 8, F11). Крючок писателя
 * (`WriterOptions.onRejected`) зовётся до броска отказа; здесь вердикт идёт через того же судью
 * каталога и пишется той же парой `decision` + `signal`, что у предикатов. Отказ СОБСТВЕННОЙ
 * строки сигнала (или её решения) второй раз в журнал не идёт — иначе отказ рождал бы отказ без
 * конца: он только отмечается в журнале ядра.
 */

export interface RejectedSinkDeps {
  /** Живая задача по id (задачи, на которые прикреплён наблюдатель); нет — отказ только отмечен. */
  taskOf(taskId: string): LiveTask | undefined;
  note: ObserverNote;
  /** Строка каталога; по умолчанию каталог ядра (тестам — подмена). */
  catalog?: (id: string) => SignalDef | undefined;
}

export type RejectedSink = (taskId: string, rejection: JournalRejection) => void;

export function createRejectedSink(deps: RejectedSinkDeps): RejectedSink {
  const catalog = deps.catalog ?? signalDef;
  // Задачи, в журнал которых сейчас пишется сигнал отказа: отказ изнутри — круг, не сигнал.
  const writing = new Set<string>();
  return (taskId, rejection) => {
    if (writing.has(taskId)) {
      deps.note('observer.rejected.recursion', { taskId, kind: rejection.kind });
      return;
    }
    const task = deps.taskOf(taskId);
    const verdict = journalRejectedVerdict(rejection, newId());
    const def = catalog(verdict.signal);
    if (!task || !def || !verdict.fired) {
      deps.note('observer.rejected.unsignalled', {
        taskId,
        kind: rejection.kind,
        reason: !task ? 'task not attached' : 'signal not in the catalog',
      });
      return;
    }
    const decision = judgeSignal(verdict, def);
    if (!decision.fired) return;
    writing.add(taskId);
    try {
      writeObserverDecision(task, verdict, decision, { inputs: [task.state.seq] });
    } catch (error) {
      deps.note('observer.write.failed', {
        taskId,
        signal: verdict.signal,
        reason: error instanceof Error ? error.message : String(error),
      });
    } finally {
      writing.delete(taskId);
    }
  };
}
