import type { QueueClass, QueueConfig, SessionTicket } from '@agentdeck/contracts/core/records';
import type { Fact } from '../../platform/os-kind.ts';
import type { Liveness, QueueHolder } from './queue.types.ts';

/**
 * Место сеанса на диске (`queue/session/seats/<ticketId>.json`, этап 11, D9): один файл на шаг
 * задачи — ждёт (`ticket.holder === null`) или держит место. Бьёт сердцем ядро-владелец; держатель
 * выданного места — ядро до открытия сеанса и хост сеанса после него (`bind`).
 */
export interface SeatFile {
  ticket: SessionTicket;
  stepId: string;
  unitId: string;
  /** Вид шага: класс порядка работ судья берёт по нему (`stepClassOf`). */
  stepKind: string;
  routeId: string;
  /** Ёмкость маршрута (`local:own` — 1); `null` — без своего предела. */
  routeCap: number | null;
  /** Предел держащих для этого шага: min(профиль задачи, `sessionSlots`). */
  limit: number;
  /** Сеанс чата: вне счёта мест, но виден распределителю. */
  interactive: boolean;
  /** Ядро-владелец: бьёт сердцем; его смерть отпускает только ждущий билет и место без сеанса. */
  core: QueueHolder;
  beatAt: number;
  grantedAt: number | null;
  /** Почему ждёт (последний проход владельца) — для `GET /v1/allocator`. */
  reason: string | null;
}

/** Что исполнитель просит: шаг, класс, маршрут и пределы, посчитанные проводкой. */
export interface SeatRequest {
  taskId: string;
  stepId: string;
  unitId: string;
  stepKind: string;
  cls: QueueClass;
  project: string;
  routeId: string;
  routeCap: number | null;
  limit: number;
  interactive: boolean;
  started: boolean;
  remainingMs: number | null;
  learnedMs: number | null;
}

/**
 * Судья выдачи — `conductor/schedule` (`decideSchedule`), данный проводкой: очередь сама порядок
 * не решает (части не зовут нутро друг друга). `grant` — id билетов в порядке выдачи.
 */
export type SeatPlanner = (input: {
  waiting: readonly SeatFile[];
  held: readonly SeatFile[];
  now: number;
  config: QueueConfig;
}) => SeatPlan;

export interface SeatPlan {
  grant: string[];
  blocked: Record<string, string>;
  /** Само решение судьи — уходит в журнал задачи строкой `schedule`. */
  detail: unknown;
}

export type SeatEvent =
  | { kind: 'seat.reaped'; ticketId: string; taskId: string; holderPid: number; silentMs: number }
  | { kind: 'seat.silent-alive'; ticketId: string; taskId: string; holderPid: number }
  | { kind: 'seat.adopted'; ticketId: string; taskId: string; fromPid: number }
  | { kind: 'seat.grant-lock'; reason: string };

export type SeatAcquire =
  | { granted: SeatFile; detail: unknown }
  | {
      waiting: string;
      ticketId: string | null;
      /** Держатель, за которым ждёт: место того же маршрута или самое старое место. */
      holder: SeatFile | null;
      detail: unknown;
    };

export interface SessionQueueDeps {
  /**
   * Каталог очереди машины (`<machine>/queue`): общий для всех домов и сборок ядра этой машины
   * (решение этапа 11: место и окно — машины, не дома).
   */
  dir: string;
  config(): QueueConfig;
  core: QueueHolder;
  build: string;
  now(): number;
  newId(): string;
  isAlive(id: { pid: number; start: string }): Promise<Liveness>;
  plan: SeatPlanner;
  onEvent?(event: SeatEvent): void;
}

export interface SessionQueue {
  beatMs(): number;
  acquire(req: SeatRequest): Promise<SeatAcquire>;
  /** Сеанс открыт: держатель места — хост сеанса (и его CLI, если личность известна). */
  bind(
    taskId: string,
    stepId: string,
    host: {
      pid: number;
      start: string;
      sessionId: string;
      cli?: { pid: number; start: string } | null;
    },
  ): boolean;
  release(taskId: string, stepId: string): boolean;
  /**
   * Удар по своим местам: место, чей хост доказанно мёртв, не бьётся (вернётся через 3 удара,
   * когда доказанно мёртв и CLI сеанса).
   * `fingerprint` — набор держащих по всей машине: сменился — где-то освободилось место.
   */
  beat(): Promise<{ fingerprint: string; hostDead: string[] }>;
  view(): Fact<SeatFile[]>;
}
