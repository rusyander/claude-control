import type { Fact } from '@agentdeck/contracts/core/facts';
import type { ProtectedRootFinding } from '@agentdeck/contracts/core/records';
import type { ReadLayer } from '../../adapters/adapter.types.ts';
import { parseRef, resourceRows } from '../../conductor/services/refs.ts';
import type { TaskRegistry } from '../../conductor/tasks.ts';
import type { LiveTask } from '../../journal/resume.ts';
import { readSessionState, writeSessionState } from './core-state.ts';
import {
  protectedRootsAtStepEnd,
  snapshotProtectedRoots,
  type ProtectedRootsInput,
  type ProtectedRootsSnapshot,
} from './protected-roots.ts';

/**
 * Защищённые корни на дороге сессии (P04 половина «эффект», G19): снимок до запуска держит дорога
 * в памяти и в доме ядра с отпечатком в журнале (`core-state.ts`) — его сравнивает и сессия,
 * прикреплённая заново после перезапуска ядра, а сама сессия не подменит ни снимок, ни корни
 * (ревью B2r4-F04: снимок в каталоге сессии стирал находку одной строкой `echo`).
 *
 * Изменчивое — то, что меняется без шага: кэш и токены самого CLI (факт переходника
 * `ReadLayer.volatile`) и копии ЭТОЙ задачи. Копии других живых задач — соседние копии под
 * защитой (06:105, ревью A2-F02): их разрушение шагом — находка; появление копии, созданной
 * ядром за шаг, — нет.
 */

export const PROTECTED_FILE = 'protected-roots.json';

export interface ProtectedHeld {
  input: ProtectedRootsInput;
  stepId: string;
  before: Fact<ProtectedRootsSnapshot>;
}

/** Рабочие копии (`resource.created {kind:'copy'}`, ещё не подтверждённые снятыми) задач. */
function copiesOf(tasks: Iterable<LiveTask>): string[] {
  const out: string[] = [];
  for (const task of tasks) {
    let rows: ReturnType<typeof resourceRows>;
    try {
      rows = resourceRows(task);
    } catch {
      // Журнал задачи не прочитался: её копия остаётся защищённой — ложная находка, не пропуск.
      continue;
    }
    for (const row of rows) {
      if (row.kind !== 'copy' || task.state.resources[row.rid]?.status === 'verified') continue;
      const worktree = parseRef(row.ref)?.worktree;
      if (typeof worktree === 'string') out.push(worktree);
    }
  }
  return out;
}

/** Копии всех живых задач — созданное ядром (не находка ни поиска ресурсов, ни появления). */
export function liveCopiesOf(registry: Pick<TaskRegistry, 'liveTasks'>): string[] {
  return copiesOf(registry.liveTasks());
}

/** Копии этой задачи — изменчивое её шага. */
export function ownCopiesOf(task: LiveTask): string[] {
  return copiesOf([task]);
}

export async function protectedBefore(input: {
  task: LiveTask;
  sessionId: string;
  stateDir: string;
  stepId: string;
  cwd: string;
  layer: ReadLayer;
  ownCopies: readonly string[];
}): Promise<ProtectedHeld> {
  const roots: ProtectedRootsInput = {
    repo: input.cwd,
    ownCopy: input.cwd,
    layer: input.layer,
    volatile: [...(input.layer.volatile ?? []), ...input.ownCopies],
  };
  const before = await snapshotProtectedRoots(roots);
  const held: ProtectedHeld = { input: roots, stepId: input.stepId, before };
  writeSessionState(input.task, input.stateDir, input.sessionId, PROTECTED_FILE, held);
  return held;
}

/**
 * Конец шага: снимок после, сравнение, сигналы `protected-root` (`stop`) в журнал задачи. Снимок
 * до шага — из памяти дороги; нет (ядро перезапускалось) — из дома ядра по журнальному
 * отпечатку. Ядро снимок писало, а прочитать его нельзя — `stop`, не `warn`: пропавший или
 * подменённый снимок — сам след разрушения.
 */
export async function protectedAtEnd(input: {
  task: LiveTask;
  sessionId: string;
  stateDir: string;
  cwd: string;
  /** Копии этой задачи сейчас и копии всех живых задач (созданные ядром) сейчас. */
  ownCopies: readonly string[];
  liveCopies: readonly string[];
  held?: ProtectedHeld;
}): Promise<Fact<ProtectedRootFinding[]>> {
  let held = input.held;
  let unreadSeverity: 'warn' | 'stop' = 'warn';
  let missing = `snapshot before the step not taken (${PROTECTED_FILE})`;
  if (!held) {
    const got = readSessionState(input.task, input.stateDir, input.sessionId, PROTECTED_FILE);
    if ('value' in got) held = got.value as ProtectedHeld;
    else if ('unknown' in got) {
      unreadSeverity = 'stop';
      missing = got.unknown;
    }
  }
  const roots: ProtectedRootsInput = held?.input ?? { repo: input.cwd, ownCopy: input.cwd };
  return protectedRootsAtStepEnd(
    input.task,
    held?.before ?? { unknown: missing },
    {
      ...roots,
      volatile: [...(roots.volatile ?? []), ...input.ownCopies],
      coreCopies: input.liveCopies,
    },
    { ...(held ? { stepId: held.stepId } : {}), unreadSeverity },
  );
}
