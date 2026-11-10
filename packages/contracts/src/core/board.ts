import { z } from 'zod';
import { sha256Hex, uuidv7 } from './ids.ts';
import type { TaskState } from './states.ts';

/**
 * Доска задач ядра (этап 12, 08d P152–P160, P181–P183): записи доски до старта задачи и карточки,
 * которые видит панель. Записи хранит одно хранилище ядра (один писатель, атомарная замена, P181);
 * колонка карточки — чистая функция фактов журнала (P152), её никто не двигает руками мимо списка
 * разрешённых ходов. Схемы строгие: лишнее поле — отказ разбора, а не тихое расширение.
 */

/** Где задача остановится сама: после плана, на MR или в конце (слияние и закрытие). */
export const BOARD_STOPS = ['plan', 'mr', 'end'] as const;
export type BoardStop = (typeof BOARD_STOPS)[number];

/** Колонки доски слева направо; «ждёт вас» и «закрыта» — не стадии, а состояния (P153). */
export const BOARD_COLUMNS = [
  'inbox',
  'queue',
  'triage',
  'work',
  'review',
  'check',
  'ready',
  'mr',
  'merged',
  'waiting',
  'closed',
] as const;
export type BoardColumn = (typeof BOARD_COLUMNS)[number];

/** Жизнь записи доски до задачи: `starting` — старт начат (оценка идёт), `started` — задача есть. */
export const BOARD_ENTRY_STATES = ['inbox', 'queued', 'starting', 'started', 'rejected'] as const;
export type BoardEntryState = (typeof BOARD_ENTRY_STATES)[number];

/**
 * Откуда запись: рукой на доске, из чата, из трекера, из форжа, из блока «Тесты», из Telegram
 * (`/task`, этап 12 P193 — никогда не в очередь сама).
 */
export const BOARD_SOURCE_KINDS = [
  'manual',
  'chat',
  'tracker',
  'forge',
  'tests',
  'telegram',
] as const;
export type BoardSourceKind = (typeof BOARD_SOURCE_KINDS)[number];

/** Куда человек двигает карточку (`POST /v1/board/move`); `restore` — из отклонённых обратно. */
/**
 * Ходы человека. `set-preset` (W2-D, P164) — сменить пресет записи до старта, колонка и ранг те же;
 * поле `preset` хода есть ровно у него (`movePresetOk`). `merge` (этап 12, D26, P186) — сложить
 * записи «Входящих» `entryIds` в запись `entryId`: их источники остаются на ней (`merged`), сами
 * записи уходят; поле `entryIds` есть ровно у него (`moveMergeOk`). Сам ядро не сливает никогда.
 */
export const BOARD_MOVES = [
  'inbox',
  'queue',
  'work',
  'rejected',
  'restore',
  'set-preset',
  'merge',
] as const;
export type BoardMoveTo = (typeof BOARD_MOVES)[number];

const shortText = z.string().min(1).max(500);
const at = z.number().int().nonnegative();

export const boardSourceSchema = z.strictObject({
  kind: z.enum(BOARD_SOURCE_KINDS),
  /** Система источника (имя трекера или форжа из настройки), без имени компании в коде. */
  system: z.string().min(1).max(100).optional(),
  /** Ключ задачи трекера или MR; у трекера и форжа ключ дедупликации — с видом, без `system` (P163). */
  key: z.string().min(1).max(200).optional(),
  url: z.string().min(1).max(2000).optional(),
  title: shortText,
});
export type BoardSource = z.infer<typeof boardSourceSchema>;

/**
 * Свойства тикета, по которым панель подсказывает «объединить» (D26, P186) — чистые факты источника:
 * эпик или родитель, связи задач, пути, названные в тексте. Живёт здесь, а не во `inbox.ts`: запись
 * доски хранит их сама, а `inbox.ts` читает `commands.ts` → `journal-data.ts` → этот модуль.
 */
export const boardRelatedSchema = z.strictObject({
  epic: z.string().min(1).max(200).optional(),
  links: z.array(z.string().min(1).max(200)).max(100),
  paths: z.array(z.string().min(1).max(1000)).max(200),
});
export type BoardRelated = z.infer<typeof boardRelatedSchema>;

/** Почему две записи связаны: общий эпик, связь задач, путь, названный в обоих тикетах. */
export const BOARD_RELATED_REASONS = ['epic', 'link', 'path'] as const;
export type BoardRelatedReason = (typeof BOARD_RELATED_REASONS)[number];

/** Подсказка «связано с …» на карточке записи (`conductor/inbox/related`, чистая функция). */
export interface BoardRelatedHint {
  entryId: string;
  title: string;
  reasons: BoardRelatedReason[];
}

/** Сколько записей один ход `merge` складывает в одну, кроме неё самой. */
export const BOARD_MERGE_MAX = 20;

/**
 * Чем задача запустится: поля формы запуска (тело оценки без доказательства) или ссылка на MR
 * для ревью по ссылке. Форму полей судит оценка при старте, а не запись доски.
 */
export const boardLaunchSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('fields'), fields: z.record(z.string(), z.json()) }),
  z.strictObject({
    kind: z.literal('link'),
    mrUrl: z.string().min(1).max(2000),
    /** Основная папка репозитория MR (как у ревью по ссылке); нет — старт вернёт запись с причиной. */
    repo: z.string().min(1).max(1000).optional(),
  }),
]);
export type BoardLaunch = z.infer<typeof boardLaunchSchema>;

/**
 * Доказательство старта (P183, 08e): ход человека на доске (`human`, его `cmdId` и стена), или
 * запись настройки, включившая автоочередь источника (`config`, `cmdId` той записи), — её ядро
 * перепроверяет при старте; запись выключена — запись возвращается во «Входящие» с причиной.
 */
export const BOARD_PROOF_KINDS = ['human', 'config'] as const;
export type BoardProofKind = (typeof BOARD_PROOF_KINDS)[number];

export const boardProofSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('human'), cmdId: uuidv7, at }),
  z.strictObject({ kind: z.literal('config'), cmdId: uuidv7 }),
]);
export type BoardProof = z.infer<typeof boardProofSchema>;

export const boardEntrySchema = z.strictObject({
  entryId: uuidv7,
  state: z.enum(BOARD_ENTRY_STATES),
  /** Порядок в колонке: меньше — выше; ход `before` ставит запись перед названной. */
  rank: z.number().finite(),
  stop: z.enum(BOARD_STOPS),
  /** Пресет сценария (`PRESET_IDS`), которым задача запустится. */
  preset: z.string().min(1).max(100),
  source: boardSourceSchema,
  launch: boardLaunchSchema,
  /** Нет — запись во «Входящих» ещё никто не ставил в очередь. */
  proof: boardProofSchema.optional(),
  /** Ключ повтора оценки при старте: тот же `cmdId` находит уже созданную задачу (G5). */
  cmdId: uuidv7.optional(),
  taskId: uuidv7.optional(),
  /** Отпечаток снимка источника: сдвиг у трекера — новая версия записи, а не тихая замена. */
  digest: sha256Hex.optional(),
  createdAt: at,
  startedAt: at.optional(),
  /** Платный маршрут при отказе подписки — только явное «да» человека этой записи (P117). */
  paidOnRefusal: z.boolean().optional(),
  /** Почему запись не стартовала или вернулась во «Входящие» — английской прозой ядра. */
  reason: z.string().max(2000).optional(),
  /** Факты связей тикета (из входящих); нет — подсказок «связано с …» у записи нет. */
  related: boardRelatedSchema.optional(),
  /**
   * Источники записей, сложенных в эту ходом `merge` (P186): ключи остаются занятыми — опрос
   * входящих их не заводит заново.
   */
  merged: z
    .array(boardSourceSchema)
    .max(BOARD_MERGE_MAX * 10)
    .optional(),
});
export type BoardEntry = z.infer<typeof boardEntrySchema>;

/**
 * Поля хода человека на доске. Тело запроса с доказательством — `boardMoveBodySchema`
 * (`panel-api.ts`): схема доказательства живёт в `commands.ts`, а тот читает `journal-data.ts`,
 * который читает этот модуль, — импорт отсюда замкнул бы круг загрузки.
 */
export const boardMoveShape = {
  /** Ключ повтора: тот же `cmdId` второй раз хода не делает (P181). */
  cmdId: uuidv7,
  entryId: uuidv7.optional(),
  taskId: uuidv7.optional(),
  to: z.enum(BOARD_MOVES),
  /** Поставить перед этой записью (только в пределах колонки очереди или входящих). */
  before: uuidv7.optional(),
  /** Новый пресет записи — только у хода `set-preset` (W2-D, P164). */
  preset: z.string().min(1).max(100).optional(),
  /** Записи, которые ход `merge` складывает в `entryId` (D26) — только у него. */
  entryIds: z.array(uuidv7).min(1).max(BOARD_MERGE_MAX).optional(),
};

/** Ровно одно из `entryId` / `taskId`: ход двигает одну карточку. */
export function oneMoveTarget(m: { entryId?: string; taskId?: string }): boolean {
  return (m.entryId === undefined) !== (m.taskId === undefined);
}

/** `preset` есть ровно у хода `set-preset`: у других ходов он ничего бы не значил. */
export function movePresetOk(m: { to: string; preset?: string }): boolean {
  return (m.to === 'set-preset') === (m.preset !== undefined);
}

/**
 * `entryIds` есть ровно у хода `merge`: он двигает запись `entryId` (не задачу), без повторов и без
 * неё самой — иначе «сложить» значило бы удалить её же.
 */
export function moveMergeOk(m: { to: string; entryId?: string; entryIds?: string[] }): boolean {
  if (m.to !== 'merge') return m.entryIds === undefined;
  const ids = m.entryIds;
  if (!ids || m.entryId === undefined) return false;
  return new Set(ids).size === ids.length && !ids.includes(m.entryId);
}

export const boardMoveSchema = z
  .strictObject(boardMoveShape)
  .refine(oneMoveTarget, { message: 'exactly one of entryId, taskId' })
  .refine(movePresetOk, { message: 'preset is set exactly on a set-preset move' })
  .refine(moveMergeOk, {
    message:
      'entryIds is set exactly on a merge move of an entry, unique, without the entry itself',
  });
export type BoardMove = z.infer<typeof boardMoveSchema>;

/**
 * Новая запись доски (`POST /v1/board/entries`: кнопка «В очередь» формы запуска, импорт из трекера):
 * ядро само даёт `entryId`, ранг, время и состояние; остановка по умолчанию — из раздела `board`.
 */
export const boardEntryDraftSchema = z.strictObject({
  stop: z.enum(BOARD_STOPS).optional(),
  preset: z.string().min(1).max(100),
  source: boardSourceSchema,
  launch: boardLaunchSchema,
  paidOnRefusal: z.boolean().optional(),
});
export type BoardEntryDraft = z.infer<typeof boardEntryDraftSchema>;

/** Карточка доски — то, что рисует панель; собирает только ядро (`GET /v1/board`). */
export interface BoardCard {
  /** `entry` — запись до задачи, `task` — задача (с записью или без, например из чата). */
  kind: 'entry' | 'task';
  /** `entryId` у записи без задачи, иначе `taskId`. */
  id: string;
  entryId?: string;
  taskId?: string;
  column: BoardColumn;
  title: string;
  /** Состояние задачи; у записи без задачи — состояние записи. */
  state?: TaskState | BoardEntryState;
  stop: BoardStop;
  preset?: string;
  source?: BoardSource;
  rank?: number;
  /** Ждёт человека: открыт хоть один блокирующий вопрос (`taskWaits`, P153). */
  waiting: boolean;
  /** Открытые неблокирующие вопросы — значок на карточке, колонка та же. */
  questions: number;
  /** Единицы задачи: сколько сдано из скольких; нет — деления ещё нет. */
  units?: { done: number; total: number };
  groupId?: string;
  parentTaskId?: string;
  launchOrigin?: { kind: 'chat'; conversationId: string };
  lead?: { profile: string; class?: string };
  mr?: { url: string; iid: number; title?: string; state: 'opened' | 'merged' | 'closed' };
  /** Открытый перехват: человек ведёт единицу сам в чате копии. */
  takeover: { unitId: string; copy: string; chatTaskId?: string } | null;
  /** Почему карточка стоит (отказ старта, ожидание окна) — английской прозой ядра. */
  reason?: string;
  /** Связанные записи «Входящих» — подсказка «связано с …» (D26); нет — связей не найдено. */
  related?: BoardRelatedHint[];
  /** Разрешённые ходы; ход вне списка — 409 с этим списком (P152). */
  moves: BoardMoveTo[];
  createdAt: number;
  startedAt?: number;
}

/** Пределы доски и сколько из них занято сейчас. */
export interface BoardLimits {
  inWork: { used: number; cap: 1 | 2 | 4 | 6 };
  perDay: { used: number; cap: number | null };
  paused: boolean;
  stopOnQuestion: boolean;
  defaultStop: BoardStop;
}

/** Ответ `GET /v1/board`. */
export interface BoardReply {
  cards: BoardCard[];
  entries: BoardEntry[];
  limits: BoardLimits;
  /**
   * Почему пределы — умолчания: раздел `board` настройки не прошёл схему (`section: 'board'`) или
   * настройка не читается целиком (`section: '*'`, запускатель тогда стоит). Нет поля — пределы
   * взяты из настройки как есть.
   */
  configIssues?: { section: string; reason: string }[];
}

/** Ответ `POST /v1/board/move`: доска после хода; `replayed` — тот же `cmdId` уже был применён. */
export interface BoardMoveReply extends BoardReply {
  replayed: boolean;
}

/** Ответ `POST /v1/board/entries`: доска после записи и id созданных записей по порядку тела. */
export interface BoardEntriesReply extends BoardMoveReply {
  created: string[];
}
