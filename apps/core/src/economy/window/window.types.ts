import type { LimitFact } from '@agentdeck/contracts/core/economy';

/** Окно маршрута для `/v1/health` (07): вердикт на вид предела, сброс, причины. */
/**
 * Общее хранилище фактов окна (P142): факт, записанный одним ядром машины, видит книга любого
 * другого. Диск — у проводки (`bootstrap/allocator-wiring`); книга остаётся чистой.
 */
export interface WindowFactStore {
  /** Все факты хранилища; не прочлось — пусто (книга судит по своей памяти). */
  read(): LimitFact[];
  write(fact: LimitFact): void;
}

export interface WindowHealthRow {
  routeId: string;
  limitKind: LimitFact['limitKind'];
  verdict: string;
  resumeAt: number | null;
  usedPct: number | null;
  observedAt: number;
}
