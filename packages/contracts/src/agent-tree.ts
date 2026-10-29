import { object, string, array, boolean, number, literal, union, type infer as Infer } from 'zod';

/**
 * Ход субагента — то, что открывается панелью справа по щелчку на узле дерева
 * агентов. Только чтение: источник — его собственный транскрипт
 * `<сессия>/subagents/agent-<id>.jsonl`, панель в него не пишет.
 */

/** Расход ответов модели: вход, чтение кэша, запись в кэш, ответ. */
export const agentTokensSchema = object({
  input: number(),
  output: number(),
  cacheRead: number(),
  cacheCreation: number(),
});

export type AgentTokenUsage = Infer<typeof agentTokensSchema>;

/**
 * Что в ходе агента стоит увидеть глазом: отказы хуков, вызовы с ошибкой,
 * повторные чтения одного файла и результаты длиннее 10 000 символов.
 */
export const agentAnomaliesSchema = object({
  denials: number(),
  errors: number(),
  /** Файлы, прочитанные `Read` больше одного раза, — по убыванию числа чтений. */
  repeatedReads: array(object({ path: string(), count: number() })),
  /** Результатов длиннее 10 000 символов. */
  largeResults: number(),
  /**
   * Вызовов, оборванных паузой или концом сессии: результата нет, CLI дописал
   * за них «[Tool call interrupted…]». Не ошибка вызова; нуль не передаётся.
   */
  interrupted: number().optional(),
});

export type AgentAnomalies = Infer<typeof agentAnomaliesSchema>;

/** Один шаг субагента:его реплика, размышление или вызов инструмента с итогом. */
export const agentStepSchema = object({
  kind: union([literal('text'), literal('thinking'), literal('tool')]),
  /** Время записи (ISO). */
  at: string().optional(),
  /** Реплика или размышление — обрезанные до разумного. */
  text: string().optional(),
  /** Имя инструмента у `tool`. */
  name: string().optional(),
  /** Чем вызван инструмент — одной строкой (команда, путь, шаблон). */
  summary: string().optional(),
  /** Начало результата вызова; нет — вызов ещё идёт. */
  result: string().optional(),
  /** Вызов кончился ошибкой. */
  isError: boolean().optional(),
  /**
   * Вызов оборван паузой или концом сессии — результата не было, CLI дописал
   * «[Tool call interrupted…]». Не ошибка: `isError` при этом нет.
   */
  interrupted: boolean().optional(),
  /** Вызов: от записи вызова до записи его результата, мс. */
  durationMs: number().optional(),
  /** Вызов: длина ВСЕГО результата в символах (`result` — только его начало). */
  resultChars: number().optional(),
  /** Вызов: хук отказал в нём — причина из вывода хука. */
  denial: string().optional(),
  /** Первый шаг ответа модели: расход этого ответа (каждый ответ — один раз). */
  usage: agentTokensSchema.optional(),
  /** Первый шаг ответа модели: модель, которая его дала. */
  model: string().optional(),
});

export type AgentStep = Infer<typeof agentStepSchema>;

/** Чем агент расширял себя: скилл, хук или инструмент сервера MCP. */
export const agentExtensionKindSchema = union([literal('skill'), literal('hook'), literal('mcp')]);

export type AgentExtensionKind = Infer<typeof agentExtensionKindSchema>;

/**
 * Итог одного срабатывания: `ok` — прошло; `error` — кончилось ошибкой;
 * `denied` — хук отказал в вызове или в конце хода; `context` — хук дописал
 * текст в контекст модели; `running` — вызов ещё идёт; `interrupted` — вызов
 * оборван паузой или концом сессии, результата не было.
 */
export const agentExtensionOutcomeSchema = union([
  literal('ok'),
  literal('error'),
  literal('denied'),
  literal('context'),
  literal('running'),
  literal('interrupted'),
]);

export type AgentExtensionOutcome = Infer<typeof agentExtensionOutcomeSchema>;

/** Одно срабатывание скилла, хука или MCP — по записи транскрипта агента. */
export const agentExtensionUseSchema = object({
  kind: agentExtensionKindSchema,
  /** Скилл — его имя; хук — имя скрипта или метка в его выводе; MCP — `сервер/инструмент`. */
  name: string(),
  /** Время записи (ISO). */
  at: string().optional(),
  /** Сколько шло: у хука — замер CLI, у скилла и MCP — от вызова до результата. */
  durationMs: number().optional(),
  outcome: agentExtensionOutcomeSchema,
  /** Событие хука («PreToolUse:Bash») и первая строка его вывода, аргументы скилла. */
  detail: string().optional(),
});

export type AgentExtensionUse = Infer<typeof agentExtensionUseSchema>;

/** Сводка по одному имени: для значков узла дерева и карточки группы. */
export const agentExtensionSummarySchema = object({
  kind: agentExtensionKindSchema,
  name: string(),
  count: number(),
  lastAt: string().optional(),
  /** Сумма замеренного времени. */
  totalMs: number().optional(),
  /** Сколько раз отказал (хук) или кончился ошибкой. */
  denied: number().optional(),
  errors: number().optional(),
});

export type AgentExtensionSummary = Infer<typeof agentExtensionSummarySchema>;

/** Хронология скиллов, хуков и MCP одного агента — для окна «Скиллы, хуки и MCP». */
export const agentExtensionsSchema = object({
  /** Нет — главный агент разговора. */
  agentId: string().optional(),
  /** Последние срабатывания по времени, не больше окна сервера. */
  items: array(agentExtensionUseSchema),
  /** Сколько срабатываний всего — раньше окна их больше, чем в `items`. */
  total: number(),
  summary: array(agentExtensionSummarySchema),
  /** Прочитан только хвост транскрипта: что было раньше, сюда не вошло. */
  partial: boolean().optional(),
});

export type AgentExtensions = Infer<typeof agentExtensionsSchema>;

export const agentTranscriptSchema = object({
  agentId: string(),
  /** Тип субагента — из meta. */
  kind: string().optional(),
  description: string().optional(),
  model: string().optional(),
  /** Задание, с которым его запустили, — первая реплика его транскрипта. */
  prompt: string().optional(),
  /** Окно шагов: последние `limit`, сдвинутые на `offset` от конца. */
  steps: array(agentStepSchema),
  /** Сколько шагов всего. */
  total: number(),
  /** Есть шаги раньше окна — «Показать раньше». */
  hasMore: boolean(),
  /** Номер первого шага окна от начала хода (с нуля). */
  start: number().optional(),
  /** Итоги по ВСЕМУ ходу, не по окну. */
  toolCalls: number().optional(),
  tokens: agentTokensSchema.optional(),
  anomalies: agentAnomaliesSchema.optional(),
  startedAt: string().optional(),
  lastAt: string().optional(),
});

export type AgentTranscript = Infer<typeof agentTranscriptSchema>;

/** Итог «Остановить субагента». */
export const agentStopResultSchema = object({
  /**
   * `requested` — CLI принял запрос. Это не «остановлен»: на чужой id CLI
   * отвечает так же (замер claude 2.1.310), — снят ли субагент, скажет его итог
   * в транскрипте (`stopped` у узла). `absent` — живого процесса нет; `refused`
   * — CLI ответил ошибкой; `unconfirmed` — запрос ушёл, ответа не дождались.
   */
  outcome: union([
    literal('requested'),
    literal('absent'),
    literal('refused'),
    literal('unconfirmed'),
  ]),
  /** Текст ошибки CLI у `refused`. */
  message: string().optional(),
});

export type AgentStopResult = Infer<typeof agentStopResultSchema>;
