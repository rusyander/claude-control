import { join } from 'node:path';
import type { BoardCard, BoardEntry, BoardReply } from '@agentdeck/contracts/core/board';
import type { BoardSection } from '@agentdeck/contracts/core/config';
import { isUuidv7 } from '@agentdeck/contracts/core/ids';
import { TASK_FILES } from '../../journal/journal.types.ts';
import { readTaskView } from '../../journal/read-view.ts';
import type { TaskFoldState } from '../../journal/reduce/reduce.types.ts';
import { fileSize, listDir } from '../../platform/safe-io/files.ts';
import type { TaskRegistry } from '../tasks.ts';
import { limitsOf } from './gates.ts';
import { entryCard, isChatTask, taskCard } from './stage.ts';

/**
 * Чтение задач для доски (этап 12, P159): доска не пересобирает журналы на каждый запрос. Живая
 * задача этого ядра — её состояние в памяти, без свёртки; остальные — свёртка, запомненная по
 * размеру журнала (журнал только дописывается: тот же размер — те же строки). Реестр (`list()`)
 * не зовётся — он сворачивает всё заново. Ни переходника, ни форжа, ни транскрипта: только журнал.
 */

export interface TaskReaderDeps {
  registry: Pick<TaskRegistry, 'tasksDir' | 'live'>;
  /** Свёртка журнала (подмена — только тест, считающий свёртки P159). */
  fold?: (tasksDir: string, taskId: string) => TaskFoldState;
}

export interface TaskReader {
  /** Состояния всех задач дома; задача, чей журнал не прочитался, пропущена и названа. */
  states(): { states: TaskFoldState[]; problems: string[] };
}

/** Свёртка задачи по умолчанию: `readTaskView` берёт каталог САМОЙ задачи, не каталог задач. */
export function foldTask(tasksDir: string, taskId: string): TaskFoldState {
  return readTaskView(join(tasksDir, taskId), taskId).state;
}

export function createTaskReader(deps: TaskReaderDeps): TaskReader {
  const fold = deps.fold ?? foldTask;
  const memo = new Map<string, { size: number; state: TaskFoldState }>();
  return {
    states() {
      const dir = deps.registry.tasksDir;
      const listed = listDir(dir);
      if ('absent' in listed) return { states: [], problems: [] };
      if ('unknown' in listed) return { states: [], problems: [`tasks dir: ${listed.unknown}`] };
      const states: TaskFoldState[] = [];
      const problems: string[] = [];
      for (const taskId of listed.value) {
        if (!isUuidv7(taskId)) continue;
        const live = deps.registry.live(taskId);
        if (live) {
          states.push(live.state);
          continue;
        }
        const size = fileSize(join(dir, taskId, TASK_FILES.journal));
        if (!('value' in size)) continue;
        const kept = memo.get(taskId);
        if (kept && kept.size === size.value) {
          states.push(kept.state);
          continue;
        }
        try {
          const state = fold(dir, taskId);
          memo.set(taskId, { size: size.value, state });
          states.push(state);
        } catch (error) {
          problems.push(`${taskId}: ${(error as Error).message}`);
        }
      }
      return { states, problems };
    },
  };
}

/** Снимок доски: карточки записей до задач, карточки задач (без чатов) и пределы. */
export function boardReplyOf(
  entries: readonly BoardEntry[],
  states: readonly TaskFoldState[],
  section: BoardSection,
  now: number,
): BoardReply {
  const byTask = new Map<string, BoardEntry>();
  for (const e of entries) if (e.taskId) byTask.set(e.taskId, e);
  // Запись группы помнит только первую задачу; остальные находят её по `boardEntry` своего создания.
  const byEntry = new Map(entries.map((e) => [e.entryId, e]));
  const entryOfTask = (s: TaskFoldState): BoardEntry | undefined => {
    const own = byTask.get(s.taskId);
    if (own) return own;
    const id = s.created?.boardEntry?.entryId;
    return id ? byEntry.get(id) : undefined;
  };
  const known = new Set(states.map((s) => s.taskId));
  const cards: BoardCard[] = [];
  for (const e of entries) {
    // Запись с задачей рисует задача; задачи ещё не видно (каталог не создан) — запись в очереди.
    if (e.taskId && known.has(e.taskId)) continue;
    const card = entryCard(e.state === 'started' ? { ...e, state: 'starting' } : e);
    if (card) cards.push(card);
  }
  for (const s of states) {
    if (isChatTask(s)) continue;
    cards.push(taskCard(s, entryOfTask(s)));
  }
  return { cards, entries: [...entries], limits: limitsOf(section, states, entries, now) };
}
