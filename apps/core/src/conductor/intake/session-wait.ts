import type { Fact } from '@agentdeck/contracts/core/facts';
import type { JournalLine } from '@agentdeck/contracts/core/journal';
import type { LearnedTable } from '../../economy/learned/index.ts';
import type { LiveTask } from '../../journal/resume.ts';
import type { SessionOccupancy } from '../estimate/estimate.types.ts';

/**
 * Ожидание места сеанса на оценке ведущего (этап 11, W3-16; P141, P144): сколько ждать, пока
 * первый сеанс задачи получит место распределителя. Только записанные факты: занятость мест
 * машины, действующая параллельность задачи (предел планировщика, `parallelismOf`) и медиана
 * законченного сеанса из выученного (`LearnedTable.sessions`). Те же факты — то же число (как P135).
 *
 * Формула. `n` = держащие + ждущие именно места; ёмкость `c` = min(профиль, `sessionSlots`) —
 * планировщик выдаёт место, пока держащих по машине меньше предела кандидата. `n < c` — место
 * свободно, 0. Иначе до нашего места должны закончиться `k = n − c + 1` сеансов, места работают
 * по `c` сразу: ожидание = ⌈k / c⌉ × медиана. Истории сеансов нет — `null` («не оценено»), а не
 * выдуманное число (03 §Economy: числа оценки — только из истории). Занятость не прочлась — `null`
 * с причиной.
 *
 * Число пишется в журнал на оценке (`lead-session-wait`): повтор того же `cmdId` отвечает тем же
 * числом, а не занятостью минуты повтора.
 */

export const SESSION_WAIT_SIGNAL = 'lead-session-wait';

export interface SessionWaitFacts {
  /** Действующая параллельность задачи: min(профиль, `queue.sessionSlots`). */
  capacity: number;
  occupancy: Fact<SessionOccupancy>;
  /** Медиана законченного сеанса, мс; `null` — образцов нет. */
  medianMs: number | null;
  samples: number;
}

export interface SessionWait {
  waitMs: number | null;
  why: string;
  capacity: number;
  holders: number | null;
  slotWaiters: number | null;
  medianMs: number | null;
  samples: number;
}

/** Медиана сеанса из выученного; таблицы или образцов нет — `null`. */
export function sessionMedianOf(table: LearnedTable | null): {
  medianMs: number | null;
  samples: number;
} {
  const s = table?.sessions;
  return s ? { medianMs: s.medianMs, samples: s.samples } : { medianMs: null, samples: 0 };
}

export function sessionWaitOf(f: SessionWaitFacts): SessionWait {
  const base = { capacity: f.capacity, medianMs: f.medianMs, samples: f.samples };
  if (!('value' in f.occupancy)) {
    const reason = 'unknown' in f.occupancy ? f.occupancy.unknown : 'absent';
    return {
      ...base,
      waitMs: null,
      holders: null,
      slotWaiters: null,
      why: `session seats unreadable: ${reason}`,
    };
  }
  const { holders, slotWaiters } = f.occupancy.value;
  const seen = { ...base, holders, slotWaiters };
  if (!(f.capacity >= 1))
    return { ...seen, waitMs: null, why: `capacity ${f.capacity}: no seat ever frees` };
  const n = holders + slotWaiters;
  if (n < f.capacity)
    return {
      ...seen,
      waitMs: 0,
      why: `${n} of ${f.capacity} seats taken or queued: a seat is free`,
    };
  if (f.medianMs === null)
    return {
      ...seen,
      waitMs: null,
      why: `${n} of ${f.capacity} seats taken or queued, no finished session in history`,
    };
  const ends = n - f.capacity + 1;
  const waves = Math.ceil(ends / f.capacity);
  return {
    ...seen,
    waitMs: waves * f.medianMs,
    why: `${ends} session(s) must end first, ${f.capacity} at a time: ${waves} × median ${f.medianMs} ms over ${f.samples} sessions`,
  };
}

/** Строка ожидания места в журнал задачи на оценке. */
export function journalSessionWait(task: LiveTask, wait: SessionWait, cmdId: string): void {
  task.append({
    kind: 'signal',
    actor: 'core',
    cmdId,
    data: {
      signal: SESSION_WAIT_SIGNAL,
      severity: 'info',
      subject: 'estimate',
      detail: JSON.stringify(wait),
    },
  });
}

/** Записанное ожидание (последняя строка); строки нет или она чужой формы — `null`. */
export function recordedSessionWait(lines: readonly JournalLine[]): number | null {
  let out: number | null = null;
  for (const l of lines) {
    if (l.kind !== 'signal') continue;
    const s = (l as JournalLine<'signal'>).data;
    if (s.signal !== SESSION_WAIT_SIGNAL) continue;
    out = waitOfDetail(s.detail);
  }
  return out;
}

function waitOfDetail(detail: string): number | null {
  try {
    const v = (JSON.parse(detail) as { waitMs?: unknown } | null)?.waitMs;
    return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null;
  } catch {
    return null;
  }
}
