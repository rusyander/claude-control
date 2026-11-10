import type {
  BoardEntriesReply,
  BoardEntryDraft,
  BoardMove,
  BoardMoveReply,
  BoardMoveTo,
  BoardReply,
  BoardStop,
} from '@agentdeck/contracts/core/board';
import type { BoardFile } from './store.types.ts';

/**
 * Порты доски задач (этап 12, зона Z1). Тело — `conductor/board/board.ts`, собирает проводка
 * `bootstrap/board-wiring.ts`; пока её порт пуст, `/v1/board*` отвечают 501, а команды, которым
 * нужен запускатель, — отказом `board-unwired`.
 */

/** Исход хода человека: применён (или повтор того же `cmdId`) — или отказ с разрешёнными ходами. */
export type BoardMoveOutcome =
  | { ok: true; reply: BoardMoveReply; replayed: boolean }
  | {
      ok: false;
      status: 404 | 409;
      code: 'unknown-card' | 'move-not-allowed';
      /** Ходы, разрешённые карточке сейчас (P152); у неизвестной карточки — пусто. */
      allowed: BoardMoveTo[];
      reason: string;
    };

/** Исход новых записей: записаны (или повтор) — или отказ 422 с причинами, ничего не записано. */
export type BoardEntriesOutcome =
  | { ok: true; reply: BoardEntriesReply }
  | { ok: false; status: 422; code: 'entries-refused'; problems: string[] };

/** Доска для API: снимок карточек и ход человека. Суд полномочий `board-move` — у API, до порта. */
export interface BoardPort {
  /** Снимок; хранилище не прочиталось — бросает (500), а не «пусто». */
  read(): Promise<BoardReply>;
  /** Тот же `cmdId` уже применён — снимок с `replayed: true`, без второго хода (P181). */
  replayed(cmdId: string): Promise<BoardEntriesReply | undefined>;
  move(move: BoardMove): Promise<BoardMoveOutcome>;
  entries(input: {
    cmdId: string;
    to: 'inbox' | 'queue';
    entries: readonly BoardEntryDraft[];
  }): Promise<BoardEntriesOutcome>;
  /**
   * Записи самого ядра (входящие, этап 12 Z7, P163): правка копии файла под ЕДИНСТВЕННЫМ писателем
   * доски — решение «ключ уже есть» и запись идут одним шагом. Логика — у вызывающего
   * (`conductor/inbox/dedupe.ts`); `write: false` — ничего не писать. `cmdId` — ключ повтора хода
   * человека (`POST /v1/inbox`), `null` — опрос ядра.
   */
  intake?<T>(
    cmdId: string | null,
    change: (
      file: BoardFile,
      ctx: { at: number; stop: BoardStop; newId: () => string },
    ) => {
      write: boolean;
      created?: string[];
      value: T;
    },
  ): T;
}

/**
 * Доска для команд задачи: перехват освободил место или задача кончилась — запускатель смотрит
 * очередь сейчас, а не на следующем такте (P154).
 */
export interface BoardCommandPort {
  tick(): void;
}
