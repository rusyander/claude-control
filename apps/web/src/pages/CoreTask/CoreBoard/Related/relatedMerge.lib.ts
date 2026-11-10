import { useMutation, useQueryClient } from '@tanstack/react-query';
import {
  BOARD_MERGE_MAX,
  type BoardCard,
  type BoardRelatedHint,
  type BoardRelatedReason,
} from '@agentdeck/contracts/core/board';
import { INTAKE_SOURCES_MAX } from '@agentdeck/contracts/core/intake';
import type { BoardMoveBody } from '@agentdeck/contracts/core/panel-api';
import {
  CORE_BOARD_KEY,
  corePost,
  fetchNonce,
  keyedRefusalOf,
  newUuidv7,
  pageLoadId,
  type KeyedRefusal,
  type RefusalRule,
} from '@entities/CoreTask';

/**
 * Подсказки «связано с …» и ход «Объединить» (этап 12, B11, D26, P186). Подсказки считает ядро
 * (`GET /v1/board`, поле карточки `related`); панель только рисует их и шлёт ход человека `merge`
 * тем же путём, что прочие ходы доски: число страницы у ядра, ключ повтора, суд `board-move`.
 */

/** Можно ли объединять в эту карточку: запись «Входящих», ядро разрешило `merge`, связи есть. */
export function canMerge(card: Pick<BoardCard, 'kind' | 'moves' | 'related'>): boolean {
  return card.kind === 'entry' && card.moves.includes('merge') && (card.related?.length ?? 0) > 0;
}

/** Тело хода `merge`: запись-цель и сложенные в неё записи, ключ повтора и доказательство страницы. */
export function mergeMoveBody(
  entryId: string,
  entryIds: readonly string[],
  proof: { nonce: string; page: string },
  cmdId: string = newUuidv7(),
): BoardMoveBody {
  return { cmdId, entryId, to: 'merge', entryIds: [...entryIds], proof };
}

/**
 * Сколько записей можно сложить одним ходом: ядро берёт в задачу не больше `INTAKE_SOURCES_MAX`
 * снимков тикета (цель — один из них) и не больше `BOARD_MERGE_MAX` записей за ход. У записи,
 * в которую уже складывали, снимков больше одного — такой перебор ядро называет отказом сам.
 */
export const MERGE_PICK_MAX = Math.min(BOARD_MERGE_MAX, INTAKE_SOURCES_MAX - 1);

/**
 * Отмеченные записи: по умолчанию отмечены первые `MERGE_PICK_MAX`, `toggled` — те, чью отметку
 * человек переключил. Хранятся переключения, а не выбор: доска перечитывается раз в 5 с, и новая
 * связь в пределе приходит отмеченной. Сверх предела не отмечается ничего.
 */
export function pickedOf(
  related: readonly Pick<BoardRelatedHint, 'entryId'>[],
  toggled: ReadonlySet<string>,
): string[] {
  return related
    .filter((h, i) => i < MERGE_PICK_MAX !== toggled.has(h.entryId))
    .map((h) => h.entryId)
    .slice(0, MERGE_PICK_MAX);
}

/** Порядок причин на экране — порядок контракта, без повторов. */
export function reasonKeys(reasons: readonly BoardRelatedReason[]): BoardRelatedReason[] {
  const order: BoardRelatedReason[] = ['epic', 'link', 'path'];
  return order.filter((r) => reasons.includes(r));
}

/**
 * Отказ хода `merge` для человека: ключ строки `coreBoard.related.refusals.*`, значения в неё и
 * проза ядра как есть. Проза `moves.ts` `applyMerge` английская по контракту (какая запись и
 * почему: ушла в очередь, MR-запись, перебор снимков), поэтому на экран идёт только подсказкой;
 * незнакомая причина — общее «ядро отказало», ответа нет — «ядро не ответило».
 */
export type MergeRefusal = KeyedRefusal;

const MERGE_REFUSAL_RULES: readonly RefusalRule[] = [
  [
    /^entry \S+ \(([^)]+)\) is \S+: only inbox entries merge/,
    'notInbox',
    (m) => ({ ticket: m[1] ?? '' }),
  ],
  [/^entry \S+ \(([^)]+)\) starts from its MR link/, 'mrEntry', (m) => ({ ticket: m[1] ?? '' })],
  [
    /^entry \S+ \(([^)]+)\) carries no ticket snapshot/,
    'noTicket',
    (m) => ({ ticket: m[1] ?? '' }),
  ],
  [
    /^merge would carry (\d+) ticket snapshots; one task takes at most (\d+)/,
    'tooManyTickets',
    (m) => ({ count: m[1] ?? '', max: m[2] ?? '' }),
  ],
  [
    /^merge would fold (\d+) sources; an entry keeps at most (\d+)/,
    'tooManySources',
    (m) => ({ count: m[1] ?? '', max: m[2] ?? '' }),
  ],
  [/^an entry does not merge into itself/, 'self', () => ({})],
  [/^merge names no entries to fold/, 'empty', () => ({})],
  [/^move merge is not allowed from/, 'notAllowed', () => ({})],
  [/^no board entry /, 'gone', () => ({})],
];

export function mergeRefusalOf(error: unknown): MergeRefusal {
  return keyedRefusalOf(error, MERGE_REFUSAL_RULES);
}

export interface MergeDraft {
  entryId: string;
  entryIds: string[];
}

/**
 * Ход «Объединить» (`POST /v1/board/move`, `to: 'merge'`). После исхода — принят или отказ — доска
 * перечитывается: какие записи остались, решает ядро, а не догадка панели.
 */
export function useBoardMerge() {
  const queryClient = useQueryClient();
  return useMutation({
    // Отказ раздел говорит сам, причиной ядра в окне; общий тост повторил бы его вторым голосом.
    meta: { silentError: true },
    mutationFn: async (draft: MergeDraft): Promise<unknown> => {
      const page = pageLoadId();
      const nonce = await fetchNonce(page);
      return corePost<unknown>(
        '/board/move',
        mergeMoveBody(draft.entryId, draft.entryIds, { nonce, page }),
      );
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey: CORE_BOARD_KEY }),
  });
}
