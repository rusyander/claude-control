import { object, string, number, array, boolean, type infer as Infer } from 'zod';

/**
 * Аналитика строится из транскриптов сессий в projects/<проект>/*.jsonl.
 * Каждый ответ модели содержит usage: сколько токенов ушло на вход, выход
 * и работу с кэшем. Это единственный доступный локально источник — остатки
 * лимитов подписки хранятся на серверах Anthropic и на диск не попадают.
 */

export const tokenTotalsSchema = object({
  input: number(),
  output: number(),
  cacheRead: number(),
  cacheCreation: number(),
  /** Сумма всех четырёх: чем платит контекст на самом деле. */
  total: number(),
  requests: number(),
});

export type TokenTotals = Infer<typeof tokenTotalsSchema>;

export const modelUsageSchema = object({
  model: string(),
  totals: tokenTotalsSchema,
  /** Оценка стоимости в долларах по тарифам API. Для подписки — справочно. */
  estimatedCost: number(),
});

export type ModelUsage = Infer<typeof modelUsageSchema>;

export const dailyUsageSchema = object({
  /** Дата в формате YYYY-MM-DD. */
  date: string(),
  totals: tokenTotalsSchema,
  estimatedCost: number(),
});

export type DailyUsage = Infer<typeof dailyUsageSchema>;

export const projectUsageSchema = object({
  /** Рабочий каталог проекта из поля cwd. */
  project: string(),
  displayName: string(),
  totals: tokenTotalsSchema,
  estimatedCost: number(),
  sessions: number(),
  lastActivity: string(),
});

export type ProjectUsage = Infer<typeof projectUsageSchema>;

export const sessionUsageSchema = object({
  sessionId: string(),
  project: string(),
  displayName: string(),
  startedAt: string(),
  lastActivity: string(),
  totals: tokenTotalsSchema,
  estimatedCost: number(),
  models: array(string()),
  gitBranch: string().optional(),
  /** Идёт ли сессия прямо сейчас: файл изменялся в последние минуты. */
  isActive: boolean(),
});

export type SessionUsage = Infer<typeof sessionUsageSchema>;

/** Запущенный процесс Claude Code — то, что реально работает на машине сейчас. */
export const runningAgentSchema = object({
  pid: number(),
  name: string(),
  memoryMb: number(),
  startedAt: string().optional(),
});

export type RunningAgent = Infer<typeof runningAgentSchema>;

export const toolUsageSchema = object({
  name: string(),
  count: number(),
});

export type ToolUsage = Infer<typeof toolUsageSchema>;

/** Почасовая активность: видно, в какие часы идёт основная работа. */
export const hourlyActivitySchema = object({
  hour: number(),
  requests: number(),
  tokens: number(),
});

export type HourlyActivity = Infer<typeof hourlyActivitySchema>;

export const analyticsSchema = object({
  /** Период, за который собраны данные. */
  from: string(),
  to: string(),
  overall: tokenTotalsSchema,
  estimatedCost: number(),
  byModel: array(modelUsageSchema),
  byDay: array(dailyUsageSchema),
  byProject: array(projectUsageSchema),
  byHour: array(hourlyActivitySchema),
  recentSessions: array(sessionUsageSchema),
  topTools: array(toolUsageSchema),
  topSkills: array(toolUsageSchema),
  runningAgents: array(runningAgentSchema),
  activeSessions: number(),
  /** Сколько файлов транскриптов просканировано и за сколько миллисекунд. */
  scannedFiles: number(),
  scanDurationMs: number(),
  /** Доля токенов, прочитанных из кэша: показывает эффективность кэширования. */
  cacheHitRatio: number(),
});

export type Analytics = Infer<typeof analyticsSchema>;
