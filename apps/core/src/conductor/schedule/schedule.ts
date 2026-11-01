import type { QueueClass } from '@agentdeck/contracts/core/records';
import { CLASS_RANK } from '../../verifier/queue/order.ts';
import type {
  ScheduleCandidate,
  ScheduleDecision,
  ScheduleInput,
  ScheduleRow,
} from './schedule.types.ts';

/**
 * Планировщик (02:80-82) — одно правило на всё ядро: класс шага deliver > fix > review > work >
 * background (тот же ранг, что у очереди проверок, `CLASS_RANK` — один порядок, не два); внутри
 * класса начатые единицы раньше новых и по остатку оценки по возрастанию (ближняя к концу
 * освобождает слот первой); новые — самые долгие по выученным длительностям первыми (длинный хвост
 * не остаётся в конце); дальше FIFO. Ожидание поднимает кандидата на класс за каждые `agingMs`
 * — поток срочных шагов не морит работу голодом. Окно лимитов сюда не входит: оно откладывает
 * через `economy/window` (03).
 */

/**
 * Класс шага по виду (00 §Words). `final-gate` — в deliver: это первый шаг дороги сдачи, и
 * единица у ворот ближе всех к концу; виды без названного класса (`check`, `ask-human`,
 * `split`) — в work.
 */
const STEP_CLASS: Record<string, QueueClass> = {
  publish: 'deliver',
  'answer-reviewers': 'deliver',
  'final-gate': 'deliver',
  fix: 'fix',
  review: 'review',
  report: 'review',
};

export function stepClassOf(stepKind: string): QueueClass {
  return STEP_CLASS[stepKind] ?? 'work';
}

function rankOf(c: ScheduleCandidate, now: number, agingMs: number): number {
  const waited = Math.max(0, now - c.waitingSince);
  const steps = agingMs > 0 ? Math.floor(waited / agingMs) : 0;
  return Math.max(0, CLASS_RANK[stepClassOf(c.stepKind)] - steps);
}

/** Неизвестное — после известного: оценку без числа не ставят впереди измеренной. */
function byKnown(a: number | null, b: number | null, dir: 1 | -1): number {
  if (a === null && b === null) return 0;
  if (a === null) return 1;
  if (b === null) return -1;
  return dir * (a - b);
}

function compare(a: ScheduleCandidate, b: ScheduleCandidate, ra: number, rb: number): number {
  if (ra !== rb) return ra - rb;
  if (a.started !== b.started) return a.started ? -1 : 1;
  const est = a.started
    ? byKnown(a.remainingMs, b.remainingMs, 1)
    : byKnown(a.learnedMs, b.learnedMs, -1);
  if (est !== 0) return est;
  if (a.waitingSince !== b.waitingSince) return a.waitingSince - b.waitingSince;
  return a.unitId < b.unitId ? -1 : 1;
}

function whyOf(c: ScheduleCandidate, rank: number): string {
  const cls = stepClassOf(c.stepKind);
  const aged = CLASS_RANK[cls] - rank;
  const est = c.started
    ? `started, remaining ${c.remainingMs ?? 'unknown'} ms`
    : `new, learned ${c.learnedMs ?? 'unknown'} ms`;
  return `${cls}${aged > 0 ? ` aged +${aged}` : ''}, ${est}`;
}

export function decideSchedule(input: ScheduleInput): ScheduleDecision {
  const ranked = input.candidates.map((c) => ({ c, rank: rankOf(c, input.now, input.agingMs) }));
  ranked.sort((x, y) => compare(x.c, y.c, x.rank, y.rank));
  const order: ScheduleRow[] = ranked.map(({ c, rank }) => ({
    unitId: c.unitId,
    cls: stepClassOf(c.stepKind),
    rank,
    why: whyOf(c, rank),
  }));
  const slots = Math.max(0, Math.floor(input.freeSlots));
  const grant = order.slice(0, slots).map((r) => r.unitId);
  const reasons = order.map((r, i) => `${i + 1}. ${r.unitId}: ${r.why}`);
  if (order.length > slots) reasons.push(`${order.length - slots} wait for a slot`);
  return { order, grant, reasons };
}
