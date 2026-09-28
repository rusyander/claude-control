import {
  array,
  boolean,
  literal,
  number,
  object,
  string,
  union,
  unknown,
  type infer as Infer,
} from 'zod';

/**
 * «Что ждёт человека и что идёт прямо сейчас» — по ВСЕМ разговорам машины
 * одним ответом (`GET /api/chat/inbox`).
 *
 * Нужен телефону: вдали от стола человек не ходит по чатам по одному, чтобы
 * узнать, кто из агентов стоит на его ответе. Панель показывает вопрос в ленте
 * самого разговора; здесь те же вопросы собраны вместе, и каждый подписан, чей
 * он. Ответ уходит теми же маршрутами, что у ленты: решение по правам —
 * `permission-decision`, ворота ветки — `branch-decision`, выбор вариантов —
 * следующим сообщением в разговор.
 */

/** Вопрос `AskUserQuestion` — одна его строка из массива `questions`. */
export const inboxQuestionSchema = object({
  question: string(),
  header: string().optional(),
  multiSelect: boolean().optional(),
  options: array(object({ label: string(), description: string().optional() })),
});
export type InboxQuestion = Infer<typeof inboxQuestionSchema>;

/**
 * Одно ожидание. `key` устойчив между опросами: по нему клиент держит уже
 * выбранный ответ, пока сервер отдаёт тот же вопрос, и снимает его, когда вопрос
 * исчез (ответили за компьютером, прогон остановлен).
 */
export const inboxAskSchema = union([
  object({
    kind: literal('permission'),
    key: string(),
    toolUseId: string(),
    toolName: string(),
    input: unknown(),
    askedAt: string(),
  }),
  object({
    /** Первая правка в основной копии: «писать здесь» или «не писать». */
    kind: literal('branchGate'),
    key: string(),
    toolUseId: string(),
    toolName: string(),
    input: unknown(),
    askedAt: string(),
  }),
  object({
    kind: literal('question'),
    key: string(),
    /** Вызов `AskUserQuestion`, которому принадлежит строка. */
    toolUseId: string().optional(),
    /** Номер строки в вызове: ответ на весь вызов собирается одним сообщением. */
    index: number().int().nonnegative(),
    /** Сколько строк в вызове — без этого клиент не знает, собран ли ответ. */
    total: number().int().positive(),
    question: inboxQuestionSchema,
    askedAt: string(),
  }),
]);
export type InboxAsk = Infer<typeof inboxAskSchema>;

export const inboxChatStatusSchema = union([
  literal('running'),
  literal('waiting'),
  literal('idle'),
]);
export type InboxChatStatus = Infer<typeof inboxChatStatusSchema>;

export const inboxChatSchema = object({
  /** Что открывает телефон: id сессии, а пока его нет — ключ прогона. */
  id: string(),
  /** Ключ прогона в реестре — им отвечают на права; нет прогона — нет и поля. */
  runKey: string().optional(),
  sessionId: string().optional(),
  title: string(),
  /** Имя папки проекта — как в списке чатов. */
  project: string(),
  projectPath: string(),
  /** Основная копия, когда разговор идёт в её git-копии: группируют по ней. */
  homeProjectPath: string().optional(),
  isSandbox: boolean(),
  /** `waiting` — есть что ответить; `running` — агент работает; `idle` — молчит. */
  status: inboxChatStatusSchema,
  /** Идёт ли прогон — и у ждущего тоже: вопрос бывает задан посреди хода. */
  running: boolean(),
  /** Последнее движение: время транскрипта, начала прогона или вопроса. */
  updatedAt: string(),
  preview: string().optional(),
  asks: array(inboxAskSchema),
});
export type InboxChat = Infer<typeof inboxChatSchema>;

export const chatInboxSchema = object({
  generatedAt: string(),
  chats: array(inboxChatSchema),
});
export type ChatInbox = Infer<typeof chatInboxSchema>;
