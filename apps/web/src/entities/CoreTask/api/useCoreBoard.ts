import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  BoardEntriesReply,
  BoardEntryDraft,
  BoardMoveTo,
  BoardReply,
} from '@agentdeck/contracts/core/board';
import type { BoardEntriesBody, BoardMoveBody } from '@agentdeck/contracts/core/panel-api';
import { queryKeys } from '@shared/api/query-keys';
import { newUuidv7, pageLoadId } from '../model/command';
import { groupLaneCount, waitingCount } from '../model/board';
import { coreGet, corePost, fetchNonce } from './coreApi';

/** Ключ доски под общим корнем ядра: сброс `core` перечитывает и её. */
export const CORE_BOARD_KEY = [...queryKeys.core.all, 'board'] as const;

/**
 * Пауза между перечитками доски (D1): 5 с, пока вкладка видна. Ядро сворачивает журнал только
 * при росте его размера (P159), поэтому частая перечитка дешева.
 */
export const BOARD_REFRESH_MS = 5_000;

/**
 * Доска задач ядра — ОДИН запрос на раздел и шапку чата (P160: счётчик «ждёт вас» в чате и
 * полосы `/groups` читают тот же ответ). Скрытая вкладка не перечитывает (`refetchIntervalInBackground`
 * по умолчанию выключен). Ядра нет или доска не подключена — ошибка запроса, решает страница.
 */
export function useCoreBoard() {
  return useQuery({
    queryKey: CORE_BOARD_KEY,
    queryFn: () => coreGet<BoardReply>('/board'),
    refetchInterval: BOARD_REFRESH_MS,
    retry: false,
    meta: { silentError: true },
  });
}

/** Число «ждёт вас» из ответа доски; ответа нет — `undefined` (не 0: незнание — не ноль). */
export function useBoardWaiting(): number | undefined {
  const { data } = useCoreBoard();
  return data ? waitingCount(data) : undefined;
}

/**
 * Пауза перечитки доски ради счётчика «Группы» в меню и сводке: меню стоит на каждой странице, и
 * 5 с доски там лишние. Открыта доска или шапка чата — их 5 с перечитывают тот же ответ чаще.
 */
export const GROUP_COUNT_REFRESH_MS = 60_000;

/**
 * Групп ядра в работе — из того же ответа доски (ключ `CORE_BOARD_KEY`, нового запроса нет).
 * Ответа нет — `count` пуст (незнание не рисуется нулём); `failed` — ядро ответило отказом или
 * молчит, а не просто ещё читается: подпись «ядро не отвечает» во время чтения была бы неправдой.
 */
export function useCoreGroupLaneCount(): { count: number | undefined; failed: boolean } {
  const { data, isError } = useQuery({
    queryKey: CORE_BOARD_KEY,
    queryFn: () => coreGet<BoardReply>('/board'),
    refetchInterval: GROUP_COUNT_REFRESH_MS,
    retry: false,
    meta: { silentError: true },
  });
  return { count: data ? groupLaneCount(data.cards) : undefined, failed: isError && !data };
}

/** Ход человека: какая карточка, куда и перед кем. */
export interface BoardMoveDraft {
  entryId?: string | undefined;
  taskId?: string | undefined;
  to: BoardMoveTo;
  before?: string | undefined;
}

/**
 * Отказ хода ядром: код, общее `error`, причина `moves.ts` как есть (`raw`, английская по контракту)
 * и ходы, разрешённые карточке сейчас (P152).
 */
export interface BoardMoveRefusal {
  status: number | undefined;
  code: string | undefined;
  reason: string;
  raw: string;
  allowed: BoardMoveTo[] | undefined;
}

/** Тело хода: ровно одна цель, ключ повтора и доказательство страницы (как у команды). */
export function boardMoveBody(
  draft: BoardMoveDraft,
  proof: { nonce: string; page: string },
  cmdId: string = newUuidv7(),
): BoardMoveBody {
  return {
    cmdId,
    // Запись без задачи двигается по `entryId`, задача — по `taskId`; ровно одно (`oneMoveTarget`).
    ...(draft.entryId ? { entryId: draft.entryId } : { taskId: draft.taskId ?? '' }),
    to: draft.to,
    ...(draft.before ? { before: draft.before } : {}),
    proof,
  };
}

/** Отказ из ошибки запроса: тело ядра `{error, code, allowed?}` или текст исключения. */
export function boardMoveRefusalOf(error: unknown): BoardMoveRefusal {
  const response = (error as { response?: { status?: number; data?: unknown } } | null)?.response;
  const data = (response?.data ?? {}) as {
    error?: unknown;
    code?: unknown;
    allowed?: unknown;
    reason?: unknown;
  };
  const allowed = Array.isArray(data.allowed)
    ? (data.allowed.filter((m) => typeof m === 'string') as BoardMoveTo[])
    : undefined;
  let reason = error instanceof Error ? error.message : String(error);
  if (typeof data.error === 'string') reason = data.error;
  return {
    status: response?.status,
    code: typeof data.code === 'string' ? data.code : undefined,
    reason,
    raw: typeof data.reason === 'string' && data.reason ? data.reason : reason,
    allowed,
  };
}

/** Правило отказа: проза ядра → ключ строки словаря и значения в неё. */
export type RefusalRule = readonly [
  RegExp,
  string,
  (m: RegExpMatchArray) => Record<string, string>,
];

/**
 * Отказ хода для человека: ключ строки словаря, значения в неё и проза ядра как есть — на экран
 * она идёт только подсказкой. Ответа нет — `noAnswer`, незнакомая причина — `generic`.
 */
export interface KeyedRefusal {
  code: string | number;
  key: string;
  values: Record<string, string>;
  raw: string;
}

export function keyedRefusalOf(error: unknown, rules: readonly RefusalRule[]): KeyedRefusal {
  const base = boardMoveRefusalOf(error);
  const code = base.code ?? base.status ?? 'error';
  if (base.status === undefined) return { code, key: 'noAnswer', values: {}, raw: base.raw };
  for (const [re, key, values] of rules) {
    const m = base.raw.match(re);
    if (m) return { code, key, values: values(m), raw: base.raw };
  }
  return { code, key: 'generic', values: {}, raw: base.raw };
}

/** Тело новых записей: куда (`inbox` | `queue`), черновики по порядку, ключ повтора и доказательство. */
export function boardEntriesBody(
  to: 'inbox' | 'queue',
  entries: BoardEntryDraft[],
  proof: { nonce: string; page: string },
  cmdId: string = newUuidv7(),
): BoardEntriesBody {
  return { cmdId, to, entries, proof };
}

/** Что уходит новой записью: куда и черновики; `cmdId` — тот же при повторе после обрыва связи. */
export interface BoardEntriesDraft {
  to: 'inbox' | 'queue';
  entries: BoardEntryDraft[];
  cmdId: string;
}

/**
 * Новые записи доски (`POST /v1/board/entries`, суд `board-move`): «В очередь» формы запуска.
 * Задачу запись не создаёт — её стартует ядро, когда освободится место (P183); после исхода доска
 * перечитывается.
 */
export function useBoardEntries() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (draft: BoardEntriesDraft): Promise<BoardEntriesReply> => {
      const page = pageLoadId();
      const nonce = await fetchNonce(page);
      return corePost<BoardEntriesReply>(
        '/board/entries',
        boardEntriesBody(draft.to, draft.entries, { nonce, page }, draft.cmdId),
      );
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey: CORE_BOARD_KEY }),
  });
}

/**
 * Ход карточки (`POST /v1/board/move`, суд `board-move`): число страницы у ядра, затем ход с
 * ключом повтора; после исхода (принят или отказ) доска перечитывается — колонку показывает ядро,
 * а не догадка панели.
 */
/** Ход карточки: доска держит его сама, чтобы отказ пережил перечитку и смену окна. */
export type BoardMove = ReturnType<typeof useBoardMove>;

export function useBoardMove() {
  const queryClient = useQueryClient();
  return useMutation({
    // Отказ окно карточки говорит само строкой под ходами; общий тост повторил бы его.
    meta: { silentError: true },
    mutationFn: async (draft: BoardMoveDraft): Promise<unknown> => {
      const page = pageLoadId();
      const nonce = await fetchNonce(page);
      return corePost<unknown>('/board/move', boardMoveBody(draft, { nonce, page }));
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey: CORE_BOARD_KEY }),
  });
}
