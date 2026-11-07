import type { LeadSection } from '@agentdeck/contracts/core/lead';
import {
  SESSION_SLOTS_DEFAULT,
  type AllocatorView,
  type QueueConfig,
  type SessionTicket,
} from '@agentdeck/contracts/core/records';
import type { SessionOccupancy } from '../../conductor/estimate/index.ts';
import { decideSchedule } from '../../conductor/schedule/index.ts';
import type { TaskFoldState } from '../../journal/reduce/reduce.types.ts';
import { resolveLeadSettings } from '../../economy/lead-settings/index.ts';
import type { SeatFile, SeatPlanner } from '../../verifier/queue/session.types.ts';

/**
 * Судья мест для очереди сеансов и цифры распределителя (этап 11, P141): порядок — один
 * упорядочиватель `conductor/schedule` (тот же ключ, что у очереди проверок); предел — профиль
 * задачи, обрезанный `queue.sessionSlots`; ёмкость маршрута — `caps.sessionCap` из реестра маршрутов.
 */

export const sessionSlotsOf = (config: QueueConfig): number =>
  config.sessionSlots ?? SESSION_SLOTS_DEFAULT;

/**
 * Параллельность задачи: профиль, с которым её запустили (`task.created.lead`), как профиль её
 * проекта, затем правки настройки и потолок `sessionSlots` (`resolveLeadSettings`). Без задачи —
 * умолчание машины.
 */
export function parallelismOf(
  section: LeadSection | undefined,
  state: TaskFoldState | null | undefined,
  sessionSlots: number,
): number {
  const created = state?.created ?? null;
  const repoKey = created?.repos[0]?.repoKey ?? null;
  const pinned = created?.lead?.profile;
  const project = repoKey === null ? undefined : section?.projects?.[repoKey];
  const pinnedSection: LeadSection | undefined =
    pinned && repoKey !== null
      ? {
          ...section,
          projects: { ...section?.projects, [repoKey]: { ...project, profile: pinned } },
        }
      : section;
  return resolveLeadSettings({ section: pinnedSection, repoKey, machine: { sessionSlots } })
    .settings.parallelism;
}

/**
 * Судья выдачи: кандидат — билет (id билета уникален по машине, единицы разных задач — нет),
 * в строках решения возвращается id единицы и задачи. Свободно — `sessionSlots` минус держащие.
 */
export const seatPlanner: SeatPlanner = ({ waiting, held, now, config }) => {
  const decision = decideSchedule({
    candidates: waiting.map((s) => ({
      unitId: s.ticket.ticketId,
      stepKind: s.stepKind,
      started: s.ticket.started,
      remainingMs: s.ticket.remainingMs,
      learnedMs: s.ticket.learnedMs,
      waitingSince: s.ticket.waitingSince,
      limit: s.limit,
      route: s.routeId,
      routeCap: s.routeCap,
    })),
    freeSlots: Math.max(0, sessionSlotsOf(config) - held.length),
    now,
    agingMs: config.agingMs,
    held: held.map((s) => ({ route: s.routeId })),
  });
  const byTicket = new Map(waiting.map((s) => [s.ticket.ticketId, s]));
  const detail = {
    ...decision,
    order: decision.order.map((row) => {
      const seat = byTicket.get(row.unitId);
      return {
        ...row,
        unitId: seat?.unitId ?? row.unitId,
        ticketId: row.unitId,
        taskId: seat?.ticket.taskId ?? null,
      };
    }),
  };
  return { grant: decision.grant, blocked: decision.blocked ?? {}, detail };
};

const ticketOf = (s: SeatFile): SessionTicket => s.ticket;

/**
 * Занятость для ожидания места на оценке (W3-16): держащие и ждущие именно места (`slot`); ждущий
 * ёмкости маршрута не стоит впереди нового сеанса в общей очереди мест. Чаты вне счёта.
 */
export function occupancyOf(view: AllocatorView): SessionOccupancy {
  return {
    holders: view.holders.length,
    slotWaiters: view.waiters.filter((w) => w.reason === 'slot').length,
  };
}

/** Ответ `GET /v1/allocator`: места машины по файлам мест, ёмкость — по умолчанию машины. */
export function allocatorView(
  seats: readonly SeatFile[],
  capacity: { parallelism: number; sessionSlots: number },
): AllocatorView {
  const counted = seats.filter((s) => !s.interactive);
  return {
    capacity: { ...capacity, effective: Math.min(capacity.parallelism, capacity.sessionSlots) },
    holders: counted.filter((s) => s.ticket.holder !== null).map(ticketOf),
    waiters: counted
      .filter((s) => s.ticket.holder === null)
      .map((s) => ({ ...s.ticket, reason: s.reason ?? 'slot' })),
    interactive: seats
      .filter((s) => s.interactive && s.ticket.holder?.sessionId != null)
      .map((s) => ({
        taskId: s.ticket.taskId,
        sessionId: s.ticket.holder!.sessionId!,
        since: s.grantedAt ?? s.beatAt,
      })),
  };
}
