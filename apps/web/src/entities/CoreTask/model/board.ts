import {
  BOARD_COLUMNS,
  type BoardCard,
  type BoardColumn,
  type BoardMoveTo,
  type BoardReply,
} from '@agentdeck/contracts/core/board';

/**
 * Доска задач ядра на стороне панели (этап 12, B7): колонку, «ждёт вас», разрешённые ходы и
 * группы карточке назначает ЯДРО (`GET /v1/board`, P152–P153). Здесь только раскладка ответа по
 * колонкам и полосам — ни одного собственного суждения о стадии или ожидании: панель, которая
 * пересчитала бы «ждёт вас» из вопросов сама, разошлась бы с ядром, ретранслятором и телефоном.
 */

/** Колонки стадий на доске — порядок контракта; «Закрытые» живут свёрнутым блоком под доской. */
export const STAGE_COLUMNS: readonly BoardColumn[] = BOARD_COLUMNS.filter((c) => c !== 'closed');

/** Колонки, в которых человек сам задаёт порядок (`rank`, ход `before`). */
const RANKED: ReadonlySet<BoardColumn> = new Set(['inbox', 'queue']);

/** Ход, которым карточка остаётся в своей колонке с порядком человека (перестановка). */
const RANKED_MOVE: Partial<Record<BoardColumn, BoardMoveTo>> = { inbox: 'inbox', queue: 'queue' };

/** Сколько карточек ждут человека — флаг карточки от ядра, а не пересчёт вопросов (P153). */
export function waitingCount(reply: Pick<BoardReply, 'cards'>): number {
  return reply.cards.filter((card) => card.waiting).length;
}

/**
 * Порядок карточек в колонке: во «Входящих» и «Очереди» — порядок человека (`rank`), иначе —
 * кто раньше вошёл в работу, тот выше (старт, затем создание). Ничья — по `id`, чтобы порядок не
 * прыгал между перечитками.
 */
export function compareCards(a: BoardCard, b: BoardCard): number {
  if (RANKED.has(a.column) && a.rank !== undefined && b.rank !== undefined && a.rank !== b.rank) {
    return a.rank - b.rank;
  }
  const at = (card: BoardCard) => card.startedAt ?? card.createdAt;
  if (at(a) !== at(b)) return at(a) - at(b);
  return a.id.localeCompare(b.id);
}

/** Карточки по колонкам: каждая колонка контракта есть (пустая — пустой список). */
export function cardsByColumn(cards: readonly BoardCard[]): Record<BoardColumn, BoardCard[]> {
  const out = Object.fromEntries(BOARD_COLUMNS.map((c) => [c, [] as BoardCard[]])) as Record<
    BoardColumn,
    BoardCard[]
  >;
  for (const card of cards) out[card.column].push(card);
  for (const column of BOARD_COLUMNS) out[column].sort(compareCards);
  return out;
}

export interface BoardLane {
  groupId: string;
  cards: BoardCard[];
}

/**
 * Полосы групп (D13): карточки с `groupId` (его ставит ядро, P159) — по одной полосе на группу,
 * полосы по самой ранней карточке. Карточки без группы в режим полос не попадают.
 */
/**
 * Сколько групп ядра в работе: полосы открытых карточек (закрытые свёрнуты под доской и полосы
 * не дают). Это число стоит у пункта «Группы» в меню и в сводке — ссылка ведёт в эти полосы.
 */
export function groupLaneCount(cards: readonly BoardCard[]): number {
  return lanesOf(cards.filter((card) => card.column !== 'closed')).length;
}

export function lanesOf(cards: readonly BoardCard[]): BoardLane[] {
  const lanes = new Map<string, BoardCard[]>();
  for (const card of cards) {
    if (!card.groupId) continue;
    const lane = lanes.get(card.groupId) ?? [];
    lane.push(card);
    lanes.set(card.groupId, lane);
  }
  const first = (lane: BoardCard[]) => Math.min(...lane.map((c) => c.createdAt));
  return [...lanes.entries()]
    .map(([groupId, laneCards]) => ({ groupId, cards: laneCards }))
    .sort((a, b) => first(a.cards) - first(b.cards) || a.groupId.localeCompare(b.groupId));
}

/**
 * Группы на доске — для отбора чипами; порядок как у полос. Выбранная группа, у которой открытых
 * карточек не осталось (всё закрылось, адрес устарел), остаётся чипом в конце: иначе доска пуста,
 * а снять отбор нечем.
 */
export function groupIdsOf(cards: readonly BoardCard[], selected?: string): string[] {
  const ids = lanesOf(cards).map((lane) => lane.groupId);
  return selected && !ids.includes(selected) ? [...ids, selected] : ids;
}

/**
 * Карточка открытого окна. Запись, которую ядро стартовало, исчезает с доски — её рисует задача с
 * тем же `entryId` (у записи группы — первая из её задач); окно идёт за ней, а не закрывается
 * само посреди чтения.
 */
export function openedCardOf(
  cards: readonly BoardCard[],
  openId: string | null,
): BoardCard | undefined {
  if (!openId) return undefined;
  return cards.find((c) => c.id === openId) ?? cards.find((c) => c.entryId === openId);
}

/** Ход, посланный из окна карточки: снимок карточки в миг хода и где ход сейчас. */
export interface SentMove {
  card: BoardCard;
  phase: 'pending' | 'refused' | 'done';
}

/** Где посланный ход — по состоянию мутации хода. */
export function sentPhaseOf(move: { isPending: boolean; isError: boolean }): SentMove['phase'] {
  if (move.isPending) return 'pending';
  if (move.isError) return 'refused';
  return 'done';
}

export interface WindowCard {
  card: BoardCard | undefined;
  /** Окно держит снимок: на доске карточки уже нет или она стала другой (запись → задача). */
  stale: boolean;
}

/**
 * Карточка окна с учётом посланного хода. Пока ход в пути или ядро его отказало, а доска уже
 * перечиталась без этой карточки (вторая страница её отклонила) или окно пошло бы за другой
 * (запись стартовала задачей), окно остаётся на снимке, с которого ход послан: иначе отказ уходит
 * вместе с окном и человек видит только, что окно пропало или стало другим. Принятый ход окно не
 * держит — оно идёт за доской, как `openedCardOf`.
 */
export function windowCardOf(
  cards: readonly BoardCard[],
  openId: string | null,
  sent: SentMove | null,
): WindowCard {
  const live = openedCardOf(cards, openId);
  if (!openId || !sent || sent.phase === 'done' || live?.id === sent.card.id)
    return { card: live, stale: false };
  return { card: sent.card, stale: true };
}

export interface BoardFilter {
  /** Только карточки этой группы. */
  group?: string | undefined;
  /** Только ждущие человека (флаг ядра). */
  waitingOnly?: boolean | undefined;
}

export function filterCards(cards: readonly BoardCard[], filter: BoardFilter): BoardCard[] {
  return cards.filter(
    (card) =>
      (!filter.group || card.groupId === filter.group) && (!filter.waitingOnly || card.waiting),
  );
}

/** Короткая метка группы для чипа и заголовка полосы: id длинный, хвоста хватает различить. */
export function shortGroupId(groupId: string): string {
  return groupId.length > 8 ? groupId.slice(-6) : groupId;
}

/**
 * Цель хода карточки: запись без задачи — по `entryId`, задача (даже стартовавшая с доски и
 * несущая `entryId`) — по `taskId`. Ровно одно поле — как требует `oneMoveTarget` контракта.
 */
export function moveTargetOf(
  card: Pick<BoardCard, 'kind' | 'id' | 'entryId' | 'taskId'>,
): { entryId: string } | { taskId: string } {
  return card.kind === 'entry'
    ? { entryId: card.entryId ?? card.id }
    : { taskId: card.taskId ?? card.id };
}

/** Порядок кнопок ходов в окне: вперёд по доске, затем назад, отклонение — последним. */
const MOVE_ORDER: readonly BoardMoveTo[] = ['work', 'queue', 'inbox', 'restore', 'rejected'];

/** Ходы карточки, которые рисует окно: ровно те, что ядро разрешило (P160), в постоянном порядке. */
export function shownMoves(card: Pick<BoardCard, 'moves'>): BoardMoveTo[] {
  return MOVE_ORDER.filter((move) => card.moves.includes(move));
}

/**
 * Ход «Выше»: в колонке с порядком человека — поставить карточку перед соседом сверху тем же
 * ходом в свою колонку (`before`). Нет соседа, или ядро не разрешило ход в эту колонку, —
 * `undefined`, кнопки нет.
 */
export function moveUp(
  card: BoardCard,
  column: readonly BoardCard[],
): { to: BoardMoveTo; before: string } | undefined {
  const to = RANKED_MOVE[card.column];
  if (!to || !card.moves.includes(to)) return undefined;
  const index = column.findIndex((c) => c.id === card.id);
  const above = index > 0 ? column[index - 1] : undefined;
  const before = above?.entryId ?? above?.taskId;
  return before ? { to, before } : undefined;
}
