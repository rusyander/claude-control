import type { QueueClass } from '@agentdeck/contracts/core/records';

/**
 * Порядок работ (02:80-82): кто из ждущих единиц получает свободный слот сессии. Кандидат —
 * единица со следующим шагом наготове; класс берётся по виду этого шага.
 */

export interface ScheduleCandidate {
  unitId: string;
  /** Вид следующего шага сценария (`StepKind`); класс — `stepClassOf`. */
  stepKind: string;
  /** Единица уже шла (у неё был шаг): ближайшая к концу идёт первой. */
  started: boolean;
  /** Остаток оценки начатой единицы; `null` — не известен. */
  remainingMs: number | null;
  /** Выученная длительность новой единицы по её области; `null` — истории нет. */
  learnedMs: number | null;
  /** С какого момента кандидат ждёт слота — FIFO и старение. */
  waitingSince: number;
}

export interface ScheduleInput {
  candidates: readonly ScheduleCandidate[];
  freeSlots: number;
  now: number;
  /** За каждые `agingMs` ожидания кандидат поднимается на класс: никто не голодает. */
  agingMs: number;
}

export interface ScheduleRow {
  unitId: string;
  cls: QueueClass;
  /** Ранг после старения: меньше — раньше. */
  rank: number;
  why: string;
}

export interface ScheduleDecision {
  /** Все кандидаты по порядку. */
  order: ScheduleRow[];
  /** Первые `freeSlots` из порядка — им слот сейчас. */
  grant: string[];
  reasons: string[];
}
