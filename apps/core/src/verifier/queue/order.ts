import type { QueueClass, QueueConfig, QueueTicket } from '@agentdeck/contracts/core/records';
import type { GrantInput, GrantPlan, QueueHolder, QueueView } from './queue.types.ts';

/**
 * Порядок очереди проверок (D§3.8, 04:114-119) — чистая модель без диска и часов: её
 * перебирает модельный тест (P38), а `queue.ts` зовёт её под замком выдачи. Порядок: класс
 * (deliver > fix > review > work > background), внутри класса — кто раньше встал; ожидание
 * поднимает билет на класс за каждые `agingMs`, поэтому `work` не голодает под потоком
 * `deliver`. Один ключ проекта — один прогон (single-flight, P68). Доля проекта ограничена,
 * пока ждёт другой проект; свободный слот, который никому другому не нужен, не простаивает.
 */

export const CLASS_RANK: Record<QueueClass, number> = {
  deliver: 0,
  fix: 1,
  review: 2,
  work: 3,
  background: 4,
};

/** Устаревший — молчит дольше трёх ударов сердца (D§3.8: «stale after 3 missed beats»). */
export const MISSED_BEATS = 3;

/**
 * Пол такта удара — один на очередь и всех, кто бьёт: настройка ниже не принимается, иначе держатель
 * бил бы реже, чем судит очередь, и живой выглядел бы молчащим на каждом проходе (B1r5-F04).
 */
export const MIN_BEAT_MS = 50;

export const DEFAULT_QUEUE_CONFIG: QueueConfig = {
  slots: 2,
  shareCap: 0.5,
  agingMs: 5 * 60_000,
  beatMs: 5_000,
};

export function holderKey(holder: QueueHolder): string {
  return `${holder.pid}:${holder.start}`;
}

export function isSilent(beatAt: number, now: number, beatMs: number): boolean {
  return now - beatAt > MISSED_BEATS * beatMs;
}

/** Ранг с учётом ожидания: меньше — раньше; ниже `deliver` не поднимается. */
export function effectiveRank(ticket: QueueTicket, now: number, agingMs: number): number {
  const waited = Math.max(0, now - ticket.enqueuedAt);
  const steps = agingMs > 0 ? Math.floor(waited / agingMs) : 0;
  return Math.max(0, CLASS_RANK[ticket.class] - steps);
}

/** Слоты в силе: мало памяти — новым выдачам вдвое меньше (04:116), но не меньше одного. */
export function slotsInForce(config: QueueConfig, lowMemory: boolean): number {
  const base = Math.max(1, Math.floor(config.slots));
  return lowMemory ? Math.max(1, Math.floor(base / 2)) : base;
}

/** Сколько слотов один проект держит, пока ждёт другой (04:118). */
export function shareCapCount(slots: number, shareCap: number): number {
  const share = Number.isFinite(shareCap) && shareCap > 0 ? Math.min(1, shareCap) : 1;
  return Math.max(1, Math.floor(slots * share));
}

function flightId(project: string, key: string | null): string | null {
  return key === null ? null : `${project}\u0000${key}`;
}

export function sortTickets(view: QueueView, now: number, agingMs: number): QueueView['tickets'] {
  return [...view.tickets].sort((a, b) => {
    const rank = effectiveRank(a.ticket, now, agingMs) - effectiveRank(b.ticket, now, agingMs);
    if (rank !== 0) return rank;
    if (a.ticket.enqueuedAt !== b.ticket.enqueuedAt)
      return a.ticket.enqueuedAt - b.ticket.enqueuedAt;
    return a.ticket.ticketId < b.ticket.ticketId ? -1 : 1;
  });
}

/**
 * Устаревшее: молчит три удара И держатель доказанно мёртв. Живость `unknown` (снимок процессов не
 * прочитался) — не «мёртв» (F25, как `exclusive-lock` и `process-identity`): иначе идущую проверку
 * снимали бы, а её слот выдавали второй раз. Такой молчун называется, не снимается.
 */
function staleOf(
  input: GrantInput,
): Pick<GrantPlan, 'staleTickets' | 'staleLeases' | 'silentAlive'> {
  const { view, now, config, liveness } = input;
  const out = {
    staleTickets: [] as string[],
    staleLeases: [] as string[],
    silentAlive: [] as string[],
  };
  for (const t of view.tickets) {
    if (!isSilent(t.beatAt, now, config.beatMs)) continue;
    if (liveness[holderKey(t.holder)] === 'dead') out.staleTickets.push(t.ticket.ticketId);
    else out.silentAlive.push(t.ticket.ticketId);
  }
  for (const l of view.leases) {
    if (!isSilent(l.heartbeatAt, now, config.beatMs)) continue;
    if (liveness[holderKey(l.holder)] === 'dead') out.staleLeases.push(l.leaseId);
    else out.silentAlive.push(l.leaseId);
  }
  return out;
}

export function planGrants(input: GrantInput): GrantPlan {
  const { view, now, config } = input;
  const stale = staleOf(input);
  const slots = slotsInForce(config, input.lowMemory);
  const cap = shareCapCount(slots, config.shareCap);
  const leases = view.leases.filter((l) => !stale.staleLeases.includes(l.leaseId));
  const waiting = sortTickets(
    {
      tickets: view.tickets.filter((t) => !stale.staleTickets.includes(t.ticket.ticketId)),
      leases,
    },
    now,
    config.agingMs,
  );
  const held = new Map<string, number>();
  const flying = new Set<string>();
  for (const l of leases) {
    held.set(l.ticket.project, (held.get(l.ticket.project) ?? 0) + 1);
    const f = flightId(l.ticket.project, l.ticket.key);
    if (f) flying.add(f);
  }
  let free = Math.max(0, slots - leases.length);
  const grant: string[] = [];
  const blocked: GrantPlan['blocked'] = {};
  // Сначала single-flight: второй билет того же ключа ждёт первый прогон, а не слот.
  const firstOfFlight = new Set<string>();
  for (const t of waiting) {
    const f = flightId(t.ticket.project, t.ticket.key);
    if (f && (flying.has(f) || firstOfFlight.has(f))) blocked[t.ticket.ticketId] = 'single-flight';
    else if (f) firstOfFlight.add(f);
  }
  const open = (id: string): boolean => !grant.includes(id) && blocked[id] !== 'single-flight';
  const otherProjectWaits = (project: string): boolean =>
    waiting.some((t) => t.ticket.project !== project && open(t.ticket.ticketId));
  for (const t of waiting) {
    const id = t.ticket.ticketId;
    if (blocked[id] === 'single-flight') continue;
    if (free === 0) {
      blocked[id] = 'slot';
      continue;
    }
    const project = t.ticket.project;
    if ((held.get(project) ?? 0) >= cap && otherProjectWaits(project)) {
      blocked[id] = 'share-cap';
      continue;
    }
    grant.push(id);
    delete blocked[id];
    held.set(project, (held.get(project) ?? 0) + 1);
    free -= 1;
  }
  // Слот, который ни одному другому проекту не достался, не простаивает (работа не теряется).
  for (const t of waiting) {
    if (free === 0) break;
    const id = t.ticket.ticketId;
    if (blocked[id] !== 'share-cap') continue;
    grant.push(id);
    delete blocked[id];
    free -= 1;
  }
  for (const t of waiting) {
    const id = t.ticket.ticketId;
    if (!grant.includes(id) && blocked[id] === undefined) blocked[id] = 'slot';
  }
  return { grant, blocked, ...stale, slots };
}

/**
 * Простой для предварительных прогонов (04:58, R:S2-30): есть свободный слот и не ждёт ни
 * один билет выше фонового класса.
 */
export function isIdle(input: GrantInput): boolean {
  const plan = planGrants(input);
  const live = input.view.leases.filter((l) => !plan.staleLeases.includes(l.leaseId)).length;
  if (live >= plan.slots) return false;
  return !input.view.tickets.some(
    (t) => !plan.staleTickets.includes(t.ticket.ticketId) && t.ticket.class !== 'background',
  );
}
