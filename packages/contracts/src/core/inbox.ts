import { z } from 'zod';
import { boardRelatedSchema } from './board.ts';
import { commandProofSchema } from './commands.ts';
import { uuidv7 } from './ids.ts';

/**
 * Входящие ядра (этап 12, D16–D18, 08d P163–P167): источники тикетов, которые ядро опрашивает само,
 * и поиск по запросу человека. Источник — трекер (Jira) или форж (GitLab); каждый его ответ — факт
 * (`readFact`), «неизвестно» записей не трогает. Записи кладёт только ядро (одна запись на ключ
 * тикета навсегда); задачу из записи — никогда сам поиск, только запускатель доски. Схемы строгие.
 */

/** Системы источников входящих; GitHub — «не поддерживается» (D16). */
export const INBOX_SYSTEMS = ['jira', 'gitlab'] as const;
export type InboxSystem = (typeof INBOX_SYSTEMS)[number];

/** Что из источника стало записью: задача трекера, MR на моё ревью, мой MR с открытыми нитями. */
export const INBOX_ITEM_KINDS = ['issue', 'review-mr', 'own-mr'] as const;
export type InboxItemKind = (typeof INBOX_ITEM_KINDS)[number];

const label = z.string().min(1).max(200);
const labels = z.array(label).max(50);

/** Метки «дефект» по умолчанию, когда источник своих не назвал (D17). */
export const INBOX_BUG_LABELS_DEFAULT = ['bug'] as const;

const sourceShape = {
  /** Имя источника в настройке; ключ дедупликации записи — вид и ключ тикета, без имени (P163). */
  id: z
    .string()
    .regex(/^[a-z0-9][a-z0-9-]{0,62}$/, 'source id')
    .max(63),
  enabled: z.boolean(),
  /** Путь проекта на форже → локальный путь репозитория; нет записи — «нет локального репозитория». */
  repos: z.record(z.string().min(1).max(500), z.string().min(1).max(1000)),
  /** Нет — `['bug']`: метка, по которой задача трекера идёт пресетом «исправить дефект». */
  bugLabels: labels.optional(),
  /** Нет — `false` (D28): запись ждёт во «Входящих», в очередь её кладёт человек. */
  autoQueue: z.boolean().optional(),
};

export const inboxSourceSchema = z.discriminatedUnion('system', [
  z.strictObject({
    ...sourceShape,
    system: z.literal('jira'),
    jira: z.strictObject({
      labels,
      assignedToMe: z.boolean(),
      /** Сохранённый запрос вместо меток; судит сам трекер. */
      jql: z.string().min(1).max(4000).optional(),
    }),
  }),
  z.strictObject({
    ...sourceShape,
    system: z.literal('gitlab'),
    gitlab: z.strictObject({
      issues: z.strictObject({ labels, assignedToMe: z.boolean() }),
      reviewerMrs: z.boolean(),
      ownMrsWithThreads: z.boolean(),
    }),
  }),
]);
export type InboxSource = z.infer<typeof inboxSourceSchema>;

/** Раздел настройки `inbox`: машинный, один на все проекты; меняет его только `set-config` человека. */
export const inboxSectionSchema = z.strictObject({
  /** Нет — `INBOX_DEFAULTS.pollMs`; чаще минуты трекер не спрашивают. */
  pollMs: z.number().int().min(60_000).max(86_400_000).optional(),
  sources: z.array(inboxSourceSchema).max(50),
  /** Нет — `false` (D18): ни строчки в трекер и форж от задач из входящих. */
  commentBack: z.boolean().optional(),
});
export type InboxSection = z.infer<typeof inboxSectionSchema>;

/** Умолчания входящих: опрос раз в пять минут, источников нет, комментариев назад нет. */
export const INBOX_DEFAULTS = {
  pollMs: 300_000,
  sources: [],
  commentBack: false,
} as const satisfies Required<InboxSection>;

/**
 * Свойства тикета, по которым панель подсказывает «объединить» (D26, P186) — чистые факты. Схема
 * живёт в `board.ts`: запись доски хранит их сама (подсказка «связано с …»), а сюда `board.ts`
 * не тянется — `inbox.ts` читает `commands.ts`, тот читает `board.ts` через журнал.
 */
export const inboxRelatedSchema = boardRelatedSchema;

/** Один тикет из источника — строка поиска и основа записи доски. */
export const inboxItemSchema = z.strictObject({
  sourceId: sourceShape.id,
  system: z.enum(INBOX_SYSTEMS),
  /** Ключ тикета (`PROJ-12`) или `<путь проекта>!<iid>` для MR. */
  key: z.string().min(1).max(300),
  kind: z.enum(INBOX_ITEM_KINDS),
  title: z.string().min(1).max(500),
  url: z.string().min(1).max(2000),
  labels,
  /** Тип задачи трекера (`Bug`, `Story`), если трекер его отдаёт. */
  type: z.string().min(1).max(100).optional(),
  /** sha256 значимых полей: изменился — запись помечается «тикет изменён». */
  digest: z.string().regex(/^[0-9a-f]{64}$/, 'sha256'),
  related: inboxRelatedSchema,
});
export type InboxItem = z.infer<typeof inboxItemSchema>;

/** Запрос поиска `GET /v1/inbox/search`: источник и, для трекера, свой запрос человека. */
export const inboxSearchQuerySchema = z.strictObject({
  sourceId: sourceShape.id,
  q: z.string().min(1).max(4000).optional(),
});
export type InboxSearchQuery = z.infer<typeof inboxSearchQuerySchema>;

/** Ответ поиска: найденное, обрезано ли по пределу, и «неизвестно» с причиной вместо выдумки. */
export interface InboxSearchReply {
  items: InboxItem[];
  truncated: boolean;
  /** Источник не ответил или не умеет — записи не тронуты, причина названа. */
  problem?: string;
}

/** Ключ записи из Telegram: `tg:<чат>:<сообщение>` — одно сообщение даёт одну запись (P193). */
export const TELEGRAM_ENTRY_KEY = /^tg:-?\d+:\d+$/;

/**
 * Что создать: выбранное в поиске (до 50 тикетов одного источника) или запись рукой из Telegram
 * (`/task <текст>`, источник доски `telegram`, никогда не в очередь сама).
 */
export const inboxCreateSchema = z.discriminatedUnion('source', [
  z.strictObject({
    source: z.literal('search'),
    sourceId: sourceShape.id,
    items: z.array(inboxItemSchema).min(1).max(50),
  }),
  z.strictObject({
    source: z.literal('telegram'),
    text: z.string().trim().min(1).max(4000),
    key: z.string().regex(TELEGRAM_ENTRY_KEY, 'tg:<chat>:<message>'),
  }),
]);
export type InboxCreate = z.infer<typeof inboxCreateSchema>;

/**
 * Тело `POST /v1/inbox` (AuthorityKind `inbox-create`, класс human, P167): только записи, никогда
 * задача; ключ повтора `cmdId`.
 */
export const inboxCreateBodySchema = z.strictObject({
  cmdId: uuidv7,
  proof: commandProofSchema,
  create: inboxCreateSchema,
});
export type InboxCreateBody = z.infer<typeof inboxCreateBodySchema>;

/** Ответ: новые записи, уже бывшие (тот же ключ — та же запись навсегда), повтор того же `cmdId`. */
export interface InboxCreateReply {
  created: string[];
  existing: string[];
  replayed: boolean;
}
