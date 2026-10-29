import type { JournalDataV1, JournalKind, JournalLine } from '@agentdeck/contracts/core/journal';
import { newId } from '../lib/ids/uuidv7.ts';
import { cutTornTail } from '../platform/safe-io/append-log.ts';
import { ensureDir } from '../platform/safe-io/files.ts';
import { join } from 'node:path';
import { acquireTaskLease, type TaskLease } from './lease.ts';
import { readJournalLines, type ReadResult } from './read-lines.ts';
import { initialState, reduce } from './reduce/reduce.ts';
import type { TaskFoldState } from './reduce/reduce.types.ts';
import { SNAPSHOT_EVERY, usableSnapshot, writeSnapshot } from './snapshot.ts';
import { openWriter, type JournalWriter } from './writer.ts';
import {
  JournalDurabilityError,
  LeaseLostError,
  TASK_FILES,
  type AppendInput,
  type CoreIdentity,
  type IsAlive,
  type JournalClock,
  type MaskFn,
} from './journal.types.ts';

/**
 * Один путь к живой задаче (01 §State, F05, P11): перезапуск, пауза, продолжение, смена CLI и
 * переезд сборки — все начинаются здесь. Порядок: аренда → обрезка оборванного хвоста (только
 * владелец) → снимок, если его `h` совпал с цепочкой, + хвост, иначе полный проход →
 * `lease.acquired` (и `journal.repaired`, если резали). Второго пути пересборки нет: `reduce`
 * импортирует только этот модуль (правило depcruise `core-reduce-only-via-resume`).
 */

export interface ResumeDeps {
  me: CoreIdentity;
  clock: JournalClock;
  mask: MaskFn;
  isAlive: IsAlive;
  now: () => number;
  /** Удары аренды по таймеру; тесты выключают и бьют сами. */
  beats?: boolean;
  /** Потеряли аренду (перехват другим ядром) — задача закрыта для записи. */
  onLeaseLost?: (taskId: string) => void;
}

export interface LiveTask {
  readonly taskId: string;
  readonly dir: string;
  readonly state: TaskFoldState;
  readonly lastHash: string;
  readonly lease: TaskLease;
  /** Маска DLP писателя: повтор команды сравнивается с маскированным телом журнала (F-25). */
  readonly mask: MaskFn;
  /** Запись + свёртка + рассылка подписчикам; снимок каждые 200 событий. */
  append<K extends JournalKind>(input: AppendInput<K>): JournalLine<K>;
  subscribe(listener: (line: JournalLine, state: TaskFoldState) => void): () => void;
  /**
   * Безопасная точка: снимок сейчас. Снимок производный, поэтому неудача замены (чужой открытый
   * дескриптор на Windows держит файл дольше ограниченного повтора) не роняет запись — ответ
   * называет причину, а следующий снимок пробует снова (P55).
   */
  snapshotNow(): { written: true } | { written: false; reason: string };
  readonly fsyncCount: number;
  /** Отставание fsync журнала, мс (`writer.journalLagMs`) — для health. */
  journalLagMs(): number;
  /** `lease.released`, снимок, отпуск аренды. Повторный вызов ничего не делает. */
  close(): void;
}

export type ResumeOutcome =
  | { ok: true; task: LiveTask; replayed: number; fromSnapshot: number | null }
  | { ok: false; reason: string; holder?: { pid: number; bootId: string } };

/** Свёртка журнала: снимок + хвост или полный проход. Общая для `resume` и вида для чтения. */
export function foldJournal(
  dir: string,
  taskId: string,
  read: ReadResult = readJournalLines(dir, taskId),
): { state: TaskFoldState; read: ReadResult; replayed: number; fromSnapshot: number | null } {
  const snapshot = usableSnapshot(dir, read.hashes);
  let state = snapshot ? snapshot.state : initialState(taskId);
  const from = snapshot ? snapshot.seq : 0;
  for (const line of read.lines.slice(from)) state = reduce(state, line);
  return { state, read, replayed: read.lines.length - from, fromSnapshot: snapshot?.seq ?? null };
}

export async function resume(
  dir: string,
  taskId: string,
  deps: ResumeDeps,
): Promise<ResumeOutcome> {
  const got = await acquireTaskLease(dir, deps.me, { isAlive: deps.isAlive, now: deps.now });
  if (!got.ok) {
    const holder = got.holder ? { pid: got.holder.pid, bootId: got.holder.bootId } : undefined;
    return { ok: false, reason: got.reason, ...(holder ? { holder } : {}) };
  }
  const lease = got.lease;
  let writer: JournalWriter | undefined;
  try {
    const repairedBytes = cutTornTail(join(dir, TASK_FILES.journal));
    const folded = foldJournal(dir, taskId);
    writer = openWriter(dir, {
      taskId,
      clock: deps.clock,
      mask: deps.mask,
      nextSeq: folded.read.lines.length + 1,
      lastHash: folded.read.lastHash,
      holdsLease: () => lease.holds(),
    });
    const task = liveTask(dir, taskId, folded.state, writer, lease, deps.mask);
    if (repairedBytes > 0) {
      task.append({ kind: 'journal.repaired', actor: 'core', data: { bytes: repairedBytes } });
    }
    const acquired: JournalDataV1['lease.acquired'] = {
      leaseId: lease.leaseId,
      build: deps.me.build,
      pid: deps.me.pid,
      pidStart: deps.me.pidStart,
      takeoverOf: lease.takeoverOf,
    };
    task.append({ kind: 'lease.acquired', actor: 'core', data: acquired });
    if (deps.beats !== false) lease.startBeats(() => deps.onLeaseLost?.(taskId));
    return { ok: true, task, replayed: folded.replayed, fromSnapshot: folded.fromSnapshot };
  } catch (error) {
    // Писатель тоже закрывается: открытый дескриптор журнала переживал отказ (ревью F-101).
    try {
      writer?.close();
    } catch {
      // fsync при закрытии — вторичная ошибка; аренда отпускается всё равно.
    }
    lease.release();
    throw error;
  }
}

function liveTask(
  dir: string,
  taskId: string,
  initial: TaskFoldState,
  writer: JournalWriter,
  lease: TaskLease,
  mask: MaskFn,
): LiveTask {
  let state = initial;
  let closed = false;
  let sinceSnapshot = 0;
  const listeners = new Set<(line: JournalLine, state: TaskFoldState) => void>();
  const commit = (line: JournalLine): void => {
    state = reduce(state, line);
    sinceSnapshot += 1;
    if (sinceSnapshot >= SNAPSHOT_EVERY) task.snapshotNow();
    for (const listener of listeners) {
      try {
        listener(line, state);
      } catch {
        // Подписчик (SSE, наблюдатель) не может сломать запись: событие уже на диске.
      }
    }
  };
  const task: LiveTask = {
    taskId,
    dir,
    lease,
    mask,
    get state() {
      return state;
    },
    get lastHash() {
      return writer.lastHash;
    },
    get fsyncCount() {
      return writer.fsyncCount;
    },
    journalLagMs: () => writer.journalLagMs(),
    append(input) {
      if (closed) throw new LeaseLostError(taskId);
      const line = (() => {
        try {
          return writer.append(input);
        } catch (error) {
          // Строка уже в файле, упал только fsync: живое состояние учитывает её, как учтёт
          // перемотка, — иначе живое и перемотанное разошлись бы (ревью M5).
          if (error instanceof JournalDurabilityError && error.line) commit(error.line);
          throw error;
        }
      })();
      commit(line);
      return line;
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    snapshotNow() {
      // Счётчик сбрасывается и при отказе: иначе каждая следующая запись снова ждала бы повтора.
      sinceSnapshot = 0;
      try {
        writeSnapshot(dir, state, writer.lastHash);
        return { written: true };
      } catch (error) {
        return { written: false, reason: error instanceof Error ? error.message : String(error) };
      }
    },
    close() {
      if (closed) return;
      try {
        if (lease.holds()) {
          task.append({ kind: 'lease.released', actor: 'core', data: { leaseId: lease.leaseId } });
          task.snapshotNow();
        }
      } catch (error) {
        // Писатель уже остановлен упавшим fsync: закрытие всё равно отпускает аренду, строка
        // об отпуске необязательна — открытие разберётся по журналу.
        if (!(error instanceof JournalDurabilityError)) throw error;
      } finally {
        closed = true;
        listeners.clear();
        writer.close();
        lease.release();
      }
    },
  };
  return task;
}

/** Новая задача: id выдаётся до всего (P49), каталог, аренда, `task.created` сразу за `lease.acquired`. */
export async function createTask(
  tasksDir: string,
  created: JournalDataV1['task.created'],
  deps: ResumeDeps,
): Promise<LiveTask> {
  const taskId = newId();
  const dir = join(tasksDir, taskId);
  ensureDir(dir);
  const outcome = await resume(dir, taskId, deps);
  if (!outcome.ok) throw new Error(`new task ${taskId} not opened: ${outcome.reason}`);
  try {
    outcome.task.append({ kind: 'task.created', actor: 'core', data: created });
  } catch (error) {
    // Отвергнутая запись не должна оставить задачу без хозяина: аренда, удары и дескриптор
    // журнала жили после `core.stop()`, и то же ядро получало `held` (ревью F-101, V6).
    try {
      outcome.task.close();
    } catch {
      // Исходная ошибка важнее: закрытие уже отпустило аренду в своём `finally`.
    }
    throw error;
  }
  return outcome.task;
}
