import type {
  InboxCreate,
  InboxCreateReply,
  InboxSearchQuery,
  InboxSearchReply,
} from '@agentdeck/contracts/core/inbox';

/**
 * Порт входящих ядра (этап 12, D16–D18, зона Z6/Z7). Тело — `conductor/inbox/`, собирает проводка
 * `bootstrap/inbox-wiring.ts`; пока её порт пуст, `/v1/inbox*` отвечают 501. Суд полномочий
 * `inbox-create` — у API, до порта.
 */

/** Исход поиска: ответ источника (с «неизвестно» внутри) — или источника нет в настройке. */
export type InboxSearchOutcome =
  | { ok: true; reply: InboxSearchReply }
  | { ok: false; status: 404; code: 'unknown-source'; reason: string };

/** Исход записей: записаны / уже были / повтор — или отказ без единой записи. */
export type InboxCreateOutcome =
  | { ok: true; reply: InboxCreateReply }
  | {
      ok: false;
      status: 404 | 422;
      code: 'unknown-source' | 'create-refused';
      problems: string[];
    };

export interface InboxPort {
  /** Поиск по источнику; ни одной записи не создаёт. */
  search(query: InboxSearchQuery): Promise<InboxSearchOutcome>;
  /** Только записи доски, никогда задача (P167); тот же `cmdId` — тот же ответ, `replayed: true`. */
  create(input: { cmdId: string; create: InboxCreate }): Promise<InboxCreateOutcome>;
  /**
   * Повтор того же `cmdId` — ответ первого раза (`replayed: true`), без суда полномочий заново:
   * API зовёт его ДО суда, как доска (Z7). Нет — ход ещё не применялся.
   */
  replayed?(input: { cmdId: string; create: InboxCreate }): Promise<InboxCreateReply | undefined>;
}
