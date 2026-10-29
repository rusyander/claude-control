import type {
  QueueClass,
  QueueConfig,
  QueueLease,
  QueueTicket,
} from '@agentdeck/contracts/core/records';
import { describe, expect, it } from 'vitest';
import {
  CLASS_RANK,
  effectiveRank,
  isIdle,
  planGrants,
  shareCapCount,
  slotsInForce,
  sortTickets,
} from './order.ts';
import type { GrantInput, Liveness, QueueView, WaitingTicket } from './queue.types.ts';

/**
 * Модель очереди (P38 половина очереди, P68 ключ, P101 «ни один проект не голодает»): полный
 * перебор малых конфигураций — каждая пара (билеты, аренды, слоты, доля) проверяется на
 * инварианты, а не на выбранные примеры.
 */

const HOLDER = { pid: 1, start: 's1', bootId: 'b' };
const NOW = 1_000_000;
const BASE: QueueConfig = { slots: 2, shareCap: 0.5, agingMs: 60_000, beatMs: 1_000 };

function ticket(
  id: string,
  cls: QueueClass,
  project: string,
  key: string | null,
  enqueuedAt: number,
): WaitingTicket {
  const t: QueueTicket = {
    ticketId: id,
    kind: 'check',
    class: cls,
    project,
    taskId: 't',
    key,
    enqueuedAt,
    build: 'b1',
  };
  return { ticket: t, holder: HOLDER, beatAt: NOW };
}

function lease(id: string, project: string, key: string | null, beatAt = NOW): QueueLease {
  return {
    leaseId: id,
    ticket: ticket(`lt-${id}`, 'work', project, key, 0).ticket,
    holder: HOLDER,
    heartbeatAt: beatAt,
    slots: 2,
  };
}

function input(
  view: QueueView,
  config: QueueConfig = BASE,
  extra: Partial<GrantInput> = {},
): GrantInput {
  return { view, now: NOW, config, liveness: {}, lowMemory: false, ...extra };
}

const flight = (project: string, key: string | null): string | null =>
  key === null ? null : `${project}/${key}`;

/** Все инварианты одного прохода; ответ — первое нарушение или null. */
function violation(inp: GrantInput): string | null {
  const plan = planGrants(inp);
  const { view } = inp;
  const slots = plan.slots;
  const cap = shareCapCount(slots, inp.config.shareCap);
  const byId = new Map(view.tickets.map((t) => [t.ticket.ticketId, t.ticket]));
  const granted = plan.grant.map((id) => byId.get(id)!);
  // I1 слоты: аренды + выдачи ≤ слотов (если аренд уже не больше слотов).
  if (view.leases.length <= slots && view.leases.length + granted.length > slots)
    return 'I1 over slots';
  // I2 один ключ — один прогон.
  const flying = new Set<string>();
  for (const x of [...view.leases.map((l) => l.ticket), ...granted]) {
    const f = flight(x.project, x.key);
    if (!f) continue;
    if (flying.has(f)) return `I2 key twice ${f}`;
    flying.add(f);
  }
  // I3 порядок: выданный билет не позже невыданного, который ждёт только слота.
  const order = sortTickets(view, inp.now, inp.config.agingMs).map((t) => t.ticket.ticketId);
  for (const g of plan.grant) {
    for (const [id, why] of Object.entries(plan.blocked)) {
      if (why === 'slot' && order.indexOf(id) < order.indexOf(g))
        return `I3 ${id} skipped for ${g}`;
    }
  }
  // I4 работа не теряется: свободный слот остался — значит каждый невыданный ждёт ключа.
  const free = slots - view.leases.length - granted.length;
  if (free > 0 && Object.values(plan.blocked).some((w) => w !== 'single-flight'))
    return 'I4 idle slot';
  // I5 доля: проект сверх доли получил слот, только если другим он не нужен.
  const count = new Map<string, number>();
  for (const l of view.leases) count.set(l.ticket.project, (count.get(l.ticket.project) ?? 0) + 1);
  for (const g of granted) {
    const n = (count.get(g.project) ?? 0) + 1;
    count.set(g.project, n);
    if (n > cap) {
      const starved = Object.entries(plan.blocked).some(
        ([id, why]) => why === 'slot' && byId.get(id)!.project !== g.project,
      );
      if (starved) return `I5 ${g.project} over cap while another project waits for a slot`;
    }
  }
  // I6 каждый билет учтён ровно один раз.
  for (const t of view.tickets) {
    const id = t.ticket.ticketId;
    const inGrant = plan.grant.includes(id);
    if (inGrant === (plan.blocked[id] !== undefined)) return `I6 ${id} granted and blocked`;
  }
  return null;
}

const CLASSES: QueueClass[] = ['deliver', 'work', 'background'];
const PROJECTS = ['a', 'b'];
const KEYS: (string | null)[] = [null, 'k'];

function* ticketChoices(): Generator<[QueueClass, string, string | null]> {
  for (const c of CLASSES) for (const p of PROJECTS) for (const k of KEYS) yield [c, p, k];
}

function* leaseSets(): Generator<QueueLease[]> {
  yield [];
  for (const p of PROJECTS)
    for (const k of KEYS) {
      yield [lease('l1', p, k)];
      for (const p2 of PROJECTS)
        for (const k2 of KEYS) {
          // Две аренды одного ключа — невозможное исходное состояние (его не выдаёт сама модель).
          if (k !== null && p === p2 && k === k2) continue;
          yield [lease('l1', p, k), lease('l2', p2, k2)];
        }
    }
}

describe('queue order model (P38 queue half, P68, P101)', () => {
  it('P38 P68 exhaustive: slots, single-flight, priority, work-conserving, share cap hold for every small queue', () => {
    const choices = [...ticketChoices()];
    let cases = 0;
    const fails: string[] = [];
    for (const slots of [1, 2, 3])
      for (const shareCap of [0.5, 1])
        for (const leases of leaseSets())
          for (let n = 0; n <= 3; n += 1) {
            const pick = (i: number): number[] =>
              n === 0
                ? []
                : [
                    i % choices.length,
                    Math.floor(i / choices.length) % choices.length,
                    Math.floor(i / choices.length ** 2),
                  ].slice(0, n);
            const total = choices.length ** n;
            for (let i = 0; i < total; i += 1) {
              const tickets = pick(i).map((c, j) => {
                const [cls, p, k] = choices[c]!;
                return ticket(`t${j}`, cls, p, k, NOW - 1_000 * (3 - j));
              });
              const inp = input({ tickets, leases }, { ...BASE, slots, shareCap });
              const bad = violation(inp);
              cases += 1;
              if (bad && fails.length < 5)
                fails.push(
                  `${bad} :: ${JSON.stringify({ slots, shareCap, leases: leases.map((l) => [l.ticket.project, l.ticket.key]), tickets: tickets.map((t) => [t.ticket.class, t.ticket.project, t.ticket.key]) })}`,
                );
            }
          }
    expect(fails).toEqual([]);
    expect(cases).toBeGreaterThan(100_000);
    // ~215 тыс. состояний: на занятой машине (параллельные прогоны) перебор идёт дольше 20 с.
  }, 180_000);

  it('P38 priority deliver > fix > review > work > background, FIFO inside a class', () => {
    const tickets = [
      ticket('w', 'work', 'a', null, NOW - 30),
      ticket('d2', 'deliver', 'a', null, NOW - 10),
      ticket('d1', 'deliver', 'a', null, NOW - 20),
      ticket('r', 'review', 'a', null, NOW - 40),
      ticket('f', 'fix', 'a', null, NOW - 5),
      ticket('bg', 'background', 'a', null, NOW - 50),
    ];
    const order = sortTickets({ tickets, leases: [] }, NOW, BASE.agingMs).map(
      (t) => t.ticket.ticketId,
    );
    expect(order).toEqual(['d1', 'd2', 'f', 'r', 'w', 'bg']);
    expect(Object.keys(CLASS_RANK)).toEqual(['deliver', 'fix', 'review', 'work', 'background']);
  });

  it('P38 P101 aging: a work ticket under a steady stream of deliver tickets gets a slot within its aging bound', () => {
    // Один слот, каждый такт: аренда кончается, приходит свежий deliver. Без старения work ждал бы вечно.
    const run = (agingMs: number): number | null => {
      const tick = 10_000;
      let now = NOW;
      let tickets: WaitingTicket[] = [ticket('work', 'work', 'a', null, now)];
      for (let step = 0; step < 100; step += 1) {
        tickets.push(ticket(`d${step}`, 'deliver', 'a', null, now));
        // Ждущие бьют сердцем: молчащий билет модель сняла бы как устаревший.
        tickets = tickets.map((t) => ({ ...t, beatAt: now }));
        const plan = planGrants(
          input({ tickets, leases: [] }, { ...BASE, slots: 1, agingMs }, { now }),
        );
        if (plan.grant.includes('work')) return step;
        tickets = tickets.filter((t) => !plan.grant.includes(t.ticket.ticketId));
        now += tick;
      }
      return null;
    };
    const step = run(60_000);
    expect(step).not.toBeNull();
    // 3 класса до deliver × 60 с старения / 10 с такта = 18 тактов, потом FIFO отдаёт старшему.
    expect(step!).toBeLessThanOrEqual(19);
    expect(run(0)).toBeNull(); // без старения work голодает — проверка умеет краснеть
    expect(
      effectiveRank(ticket('x', 'background', 'a', null, NOW - 10 * 60_000).ticket, NOW, 60_000),
    ).toBe(0);
  });

  it('P101 no project starves: a flood of one project leaves the other a slot (share cap), an idle slot is not held back', () => {
    const flood = Array.from({ length: 6 }, (_, i) =>
      ticket(`a${i}`, 'deliver', 'a', null, NOW - 100 + i),
    );
    const other = ticket('b0', 'background', 'b', null, NOW);
    const plan = planGrants(
      input({ tickets: [...flood, other], leases: [] }, { ...BASE, slots: 2 }),
    );
    expect(plan.grant).toEqual(['a0', 'b0']);
    expect(plan.blocked['a1']).toBe('share-cap');
    // Нет другого проекта — доля не держит слот впустую.
    const alone = planGrants(input({ tickets: flood, leases: [] }, { ...BASE, slots: 2 }));
    expect(alone.grant).toEqual(['a0', 'a1']);
  });

  it('P68 one key single-flight: a second ticket of a leased key waits for the run, not for a slot', () => {
    const plan = planGrants(
      input(
        {
          tickets: [ticket('t1', 'deliver', 'a', 'k', NOW), ticket('t2', 'deliver', 'b', 'k', NOW)],
          leases: [lease('l1', 'a', 'k')],
        },
        { ...BASE, slots: 3, shareCap: 1 },
      ),
    );
    expect(plan.blocked['t1']).toBe('single-flight');
    expect(plan.grant).toEqual(['t2']); // тот же ключ другого проекта — другое хранилище записей
  });

  it('P38 stale holder: 3 missed beats + dead → reaped and its slot reused; a silent live or unknown holder is named, kept (F25, A1r3-F03)', () => {
    const beat = BASE.beatMs;
    const old = NOW - 3 * beat - 1;
    const tickets = [ticket('t', 'work', 'a', null, NOW)];
    const view = {
      tickets,
      leases: [lease('dead', 'a', null, old), lease('fresh', 'b', null, NOW - 3 * beat)],
    };
    const dead = planGrants(input(view, BASE, { liveness: { '1:s1': 'dead' } }));
    expect(dead.staleLeases).toEqual(['dead']);
    expect(dead.grant).toEqual(['t']);
    // Снимок процессов не прочитался — не «мёртв» (как exclusive-lock и process-identity):
    // идущую проверку не снимают, её слот второй раз не выдают.
    const doubtful: Record<string, Liveness>[] = [{ '1:s1': 'unknown' }, {}];
    for (const liveness of doubtful) {
      const unknown = planGrants(input(view, BASE, { liveness }));
      expect(unknown.staleLeases).toEqual([]);
      expect(unknown.silentAlive).toEqual(['dead']);
      expect(unknown.grant).toEqual([]);
    }
    const alive = planGrants(input(view, BASE, { liveness: { '1:s1': 'alive' } }));
    expect(alive.staleLeases).toEqual([]);
    expect(alive.silentAlive).toEqual(['dead']);
    expect(alive.grant).toEqual([]);
    const silentTicket = { ...ticket('quiet', 'deliver', 'a', null, NOW), beatAt: old };
    const reaped = planGrants(
      input({ tickets: [silentTicket], leases: [] }, BASE, { liveness: { '1:s1': 'dead' } }),
    );
    expect(reaped.staleTickets).toEqual(['quiet']);
    expect(reaped.grant).toEqual([]);
  });

  it('04:116 low memory halves the slots for new grants (never below one); idle = free slot and nothing above background waits', () => {
    expect(slotsInForce({ ...BASE, slots: 4 }, true)).toBe(2);
    expect(slotsInForce({ ...BASE, slots: 1 }, true)).toBe(1);
    const tickets = [ticket('t1', 'work', 'a', null, NOW), ticket('t2', 'work', 'b', null, NOW)];
    expect(
      planGrants(input({ tickets, leases: [] }, { ...BASE, slots: 4 }, { lowMemory: true })).grant,
    ).toEqual(['t1', 't2']);
    expect(
      planGrants(
        input(
          { tickets, leases: [lease('l', 'c', null)] },
          { ...BASE, slots: 4 },
          { lowMemory: true },
        ),
      ).grant,
    ).toEqual(['t1']);
    expect(isIdle(input({ tickets: [], leases: [] }))).toBe(true);
    expect(
      isIdle(input({ tickets: [ticket('bg', 'background', 'a', null, NOW)], leases: [] })),
    ).toBe(true);
    expect(isIdle(input({ tickets: [ticket('w', 'work', 'a', null, NOW)], leases: [] }))).toBe(
      false,
    );
    expect(
      isIdle(input({ tickets: [], leases: [lease('l1', 'a', null), lease('l2', 'b', null)] })),
    ).toBe(false);
  });
});
