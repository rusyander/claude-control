import type { QueueConfig, QueueLease, QueueTicket } from '@agentdeck/contracts/core/records';

/** Кто держит билет или аренду: личность процесса (P12) — по ней решается «мёртв ли». */
export type QueueHolder = QueueLease['holder'];

/** Билет на диске (`queue/check/tickets/<ticketId>.json`): ждущий бьёт сердцем, пока ждёт. */
export interface WaitingTicket {
  ticket: QueueTicket;
  holder: QueueHolder;
  beatAt: number;
}

/** Всё, что видно в каталоге очереди за один проход под замком выдачи. */
export interface QueueView {
  tickets: WaitingTicket[];
  leases: QueueLease[];
}

export type Liveness = 'alive' | 'dead' | 'unknown';

/** Почему билет не получил слот в этот проход. */
export type BlockReason = 'slot' | 'share-cap' | 'single-flight';

/** План выдачи (чистая модель): кому слот, кто ждёт и почему, что убрать как устаревшее. */
export interface GrantPlan {
  grant: string[]; // ticketId в порядке выдачи
  blocked: Record<string, BlockReason>;
  staleTickets: string[];
  staleLeases: string[];
  /** Молчит 3 удара, но смерть держателя не доказана (жив или `unknown`): не снимается (F25), называется. */
  silentAlive: string[];
  slots: number; // слоты в силе на этот проход (низкая память снижает)
}

export interface GrantInput {
  view: QueueView;
  now: number;
  config: QueueConfig;
  /** Жив ли держатель по `pid:start` (P12); спрашивается только у молчащих. */
  liveness: Record<string, Liveness>;
  lowMemory: boolean;
}

/** События очереди: обвязка кладёт их в `logs/core.jsonl` (снятые устаревшие, молчащие живые). */
export type QueueEvent =
  | { kind: 'reaped'; what: 'ticket' | 'lease'; id: string; holderPid: number; silentMs: number }
  | { kind: 'silent-alive'; id: string; holderPid: number; silentMs: number }
  | { kind: 'grant-lock'; reason: string };

/** `unwritable` — слот выдан, но аренда не записалась (диск, антивирус): билет ждёт следующего прохода. */
export type AcquireAnswer =
  | { granted: QueueLease }
  | { waiting: BlockReason | 'contended' | 'unreadable' | 'unwritable'; detail: string }
  | { gone: string };

/** Держатель «в полёте» одного ключа (single-flight, P68): `inflight/<scope>.lock`. */
export interface InflightHold {
  checkRunId: string;
  since: number;
  pid: number;
}

export type HeartbeatAnswer = 'ok' | 'lost' | { unknown: string };
