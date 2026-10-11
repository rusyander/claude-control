import {
  array,
  boolean,
  literal,
  number,
  object,
  record,
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
    /**
     * Запрос прав сессии вне панели: его держит хук панели, решение уходит
     * маршрутом `/api/outside/asks`, а не `permission-decision` прогона.
     */
    relay: boolean().optional(),
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
    /**
     * Вопрос сессии вне панели, который ждёт ответа с телефона: хук панели
     * держит его и отдаст ответ CLI. Отвечают маршрутом `/api/outside/asks`,
     * а не сообщением в разговор.
     */
    relay: boolean().optional(),
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
  /**
   * Ход идёт вне панели — в терминале или VS Code, его видно только по
   * транскрипту. Сообщение панели начало бы второй ход рядом, поэтому пишут
   * сюда через `/api/outside/messages`: хук панели отдаёт текст агенту после
   * ближайшего шага. Вопросы и права такой сессии помечены `relay`.
   */
  outside: boolean().optional(),
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

/**
 * Хук панели (`PermissionRequest`) сообщает о вопросе или запросе прав сессии
 * вне панели. Окно на компьютере показывает тот же запрос одновременно: чей
 * ответ первый, тот и принят.
 */
export const outsideAskRegisterSchema = object({
  toolUseId: string().min(1),
  sessionId: string().min(1),
  cwd: string().optional(),
  toolName: string().min(1),
  input: unknown().optional(),
});
export type OutsideAskRegister = Infer<typeof outsideAskRegisterSchema>;

/**
 * Ответ с телефона: на вопрос — текст вопроса → выбранное (несколько — через
 * запятую), на запрос прав — «разрешить» или «запретить».
 */
export const outsideAnswerSchema = union([
  object({ answers: record(string(), string()) }),
  object({ behavior: union([literal('allow'), literal('deny')]) }),
]);
export type OutsideAnswer = Infer<typeof outsideAnswerSchema>;

/** Пересылка с компьютера на телефон: вопросы, права и сообщения посреди хода. */
export const outsideRelayStateSchema = object({
  enabled: boolean(),
  /** Все три хука панели стоят и включены в настройках Claude Code. */
  installed: boolean(),
  /**
   * Хук прав стоит, но его таймаут короче ожидания ответа: без явного таймаута
   * CLI снимает хук через 60 с, и запрос с телефона пропадает раньше ответа.
   */
  shortTimeout: boolean(),
  /**
   * Команда хука панели — готовая строка для раздела «Хуки»: вписать хуки в
   * настройки Claude Code человек решает сам.
   */
  command: string(),
});
export type OutsideRelayState = Infer<typeof outsideRelayStateSchema>;

/** Сообщение с телефона в ход, идущий в терминале или VS Code. */
export const outsideMessageSendSchema = object({
  sessionId: string().min(1),
  text: string().trim().min(1).max(20_000),
});

export const outsideMessageSchema = object({
  id: string(),
  text: string(),
  queuedAt: string(),
  /** Когда хук отдал его агенту: после шага или в конце хода. Нет — ещё ждёт. */
  deliveredAt: string().optional(),
});
export type OutsideMessage = Infer<typeof outsideMessageSchema>;

export const outsideMessagesSchema = object({
  messages: array(outsideMessageSchema),
  /**
   * Хуки панели уже отзывались из этой сессии. Нет — сессия могла быть
   * запущена до их установки: Claude Code читает хуки на старте, и сообщение
   * дойдёт только после её перезапуска.
   */
  hooked: boolean(),
});
export type OutsideMessages = Infer<typeof outsideMessagesSchema>;
