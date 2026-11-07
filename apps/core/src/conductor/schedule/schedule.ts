import type { QueueClass } from '@agentdeck/contracts/core/records';
import { CLASS_RANK, compareRanked, keyRank, type OrderKey } from '../../verifier/queue/order.ts';
import type {
  ScheduleCandidate,
  ScheduleDecision,
  ScheduleInput,
  ScheduleRow,
  SeatBlock,
} from './schedule.types.ts';

/**
 * Планировщик (02:80-82) — одно правило на всё ядро: класс шага deliver > fix > review > work >
 * background; внутри класса начатые единицы раньше новых и по остатку оценки по возрастанию
 * (ближняя к концу освобождает слот первой); новые — самые долгие по выученным длительностям
 * первыми (длинный хвост не остаётся в конце); дальше FIFO. Ожидание поднимает кандидата на класс
 * за каждые `agingMs` — поток срочных шагов не морит работу голодом. Сравнение — ключ порядка
 * очереди (`verifier/queue/order.ts`): у проверок и мест сеансов один упорядочиватель, не два.
 * Окно лимитов сюда не входит: оно откладывает через `economy/window` (03).
 *
 * Места сеансов (этап 11, P141): задан `held` — судья выдаёт места, а не первые `freeSlots`.
 * Кандидату место, пока всех держащих меньше его предела (min профиля и `sessionSlots`) и его
 * маршрут не полон (`local:own` — одно место). Упёрся в предел — ждут и все ниже него
 * (голова очереди): иначе поток коротких задач с большим пределом обходил бы его вечно.
 * Полный маршрут голову не держит — другие маршруты идут (P115).
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

function keyOf(c: ScheduleCandidate): OrderKey {
  return {
    cls: stepClassOf(c.stepKind),
    since: c.waitingSince,
    started: c.started,
    remainingMs: c.remainingMs,
    learnedMs: c.learnedMs,
    id: c.unitId,
  };
}

function whyOf(c: ScheduleCandidate, rank: number): string {
  const cls = stepClassOf(c.stepKind);
  const aged = CLASS_RANK[cls] - rank;
  const est = c.started
    ? `started, remaining ${c.remainingMs ?? 'unknown'} ms`
    : `new, learned ${c.learnedMs ?? 'unknown'} ms`;
  return `${cls}${aged > 0 ? ` aged +${aged}` : ''}, ${est}`;
}

/** Выдача мест сеансов по порядку: пределы кандидатов, ёмкость маршрутов, голова очереди. */
function seatGrants(
  order: readonly ScheduleRow[],
  byId: ReadonlyMap<string, ScheduleCandidate>,
  held: NonNullable<ScheduleInput['held']>,
  slots: number,
): { grant: string[]; blocked: Record<string, SeatBlock>; reasons: string[] } {
  let total = held.length;
  const onRoute = new Map<string, number>();
  for (const h of held) onRoute.set(h.route, (onRoute.get(h.route) ?? 0) + 1);
  const grant: string[] = [];
  const blocked: Record<string, SeatBlock> = {};
  const reasons: string[] = [];
  let head: string | null = null;
  for (const row of order) {
    const c = byId.get(row.unitId)!;
    const route = c.route ?? null;
    const cap = c.routeCap ?? null;
    if (route !== null && cap !== null && (onRoute.get(route) ?? 0) >= cap) {
      blocked[row.unitId] = 'route';
      reasons.push(`${row.unitId} waits: route ${route} full (${cap})`);
      continue;
    }
    const limit = Math.max(1, Math.floor(c.limit ?? slots + total));
    if (head !== null || total >= limit || grant.length >= slots) {
      blocked[row.unitId] = 'slot';
      reasons.push(
        head === null
          ? `${row.unitId} waits: ${total} of ${limit} seats held`
          : `${row.unitId} waits behind ${head}`,
      );
      head ??= row.unitId;
      continue;
    }
    grant.push(row.unitId);
    total += 1;
    if (route !== null) onRoute.set(route, (onRoute.get(route) ?? 0) + 1);
  }
  return { grant, blocked, reasons };
}

export function decideSchedule(input: ScheduleInput): ScheduleDecision {
  const ranked = input.candidates.map((c) => {
    const key = keyOf(c);
    return { c, key, rank: keyRank(key, input.now, input.agingMs) };
  });
  ranked.sort((x, y) => compareRanked(x.key, y.key, x.rank, y.rank));
  const order: ScheduleRow[] = ranked.map(({ c, rank }) => ({
    unitId: c.unitId,
    cls: stepClassOf(c.stepKind),
    rank,
    why: whyOf(c, rank),
  }));
  const slots = Math.max(0, Math.floor(input.freeSlots));
  const reasons = order.map((r, i) => `${i + 1}. ${r.unitId}: ${r.why}`);
  if (input.held) {
    const byId = new Map(input.candidates.map((c) => [c.unitId, c]));
    const seats = seatGrants(order, byId, input.held, slots);
    return {
      order,
      grant: seats.grant,
      reasons: [...reasons, ...seats.reasons],
      blocked: seats.blocked,
    };
  }
  const grant = order.slice(0, slots).map((r) => r.unitId);
  if (order.length > slots) reasons.push(`${order.length - slots} wait for a slot`);
  return { order, grant, reasons };
}
