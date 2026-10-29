import type { JournalLine } from '@agentdeck/contracts/core/journal';
import { readJournalLines } from './read-lines.ts';
import type { TaskFoldState } from './reduce/reduce.types.ts';
import { foldJournal } from './resume.ts';

/**
 * Вид задачи только для чтения (API, задача без живой аренды у этого ядра, инструменты): та же
 * свёртка, что у `resume()`, без аренды и без записи. Оборванный хвост не режется — пропускается.
 */

export interface TaskView {
  state: TaskFoldState;
  lastHash: string;
  tornBytes: number;
}

export function readTaskView(dir: string, taskId: string): TaskView {
  const folded = foldJournal(dir, taskId);
  return { state: folded.state, lastHash: folded.read.lastHash, tornBytes: folded.read.tornBytes };
}

/** События после `afterSeq` — для повтора SSE по `Last-Event-ID`. */
export function linesAfter(dir: string, taskId: string, afterSeq: number): JournalLine[] {
  return readJournalLines(dir, taskId).lines.slice(Math.max(0, afterSeq));
}
