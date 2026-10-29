import { object, string, array, boolean, number, record, type infer as Infer } from 'zod';
import { progressActiveToolSchema, progressAgentSchema } from './chat.ts';
import { agentAnomaliesSchema, agentTokensSchema } from './agent-tree.ts';

/**
 * История агентов разговора по ВСЕМ его сессиям. Группа разделения живёт
 * многими сессиями: после каждой паузы панель начинает новый разговор, ревью и
 * правки — свои чаты. Прогресс (`/api/chat/:id/progress`) знает только текущую
 * сессию, и субагенты прошлых сессий не были видны нигде. Только чтение:
 * источник — транскрипты CLI, модель не вызывается.
 */

/** Расход ответов модели: каждый ответ — один раз. */
export const agentHistoryTokensSchema = agentTokensSchema;

/** Главный агент сессии одной строкой — по ВСЕМУ транскрипту, без пропусков. */
export const agentHistoryMainSchema = object({
  /** Вызовов инструментов главным агентом. */
  toolCalls: number(),
  tokens: agentHistoryTokensSchema.optional(),
  /** Последняя модель, ответившая за главного агента. */
  model: string().optional(),
  /** Отказы хуков, ошибки, повторные чтения, большие результаты. */
  anomalies: agentAnomaliesSchema.optional(),
  /** Ход главного агента открыт: ответ ещё не закончен. */
  turnOpen: boolean().optional(),
  /**
   * Последний вызов главного агента без результата: имя, чем вызван, с какого
   * времени. У живого — то, чем он занят сейчас; у молчащего — где он встал.
   */
  openTool: progressActiveToolSchema.optional(),
  /** Последнее действие главного агента одной строкой: вызов с аргументом или реплика. */
  lastAction: string().optional(),
});

export type AgentHistoryMain = Infer<typeof agentHistoryMainSchema>;

export const agentHistorySessionSchema = object({
  /**
   * Ключ сессии, по которому находится её транскрипт, — им же открывается ход
   * её субагента (`/api/chat/:chatId/agents/:agentId`) и главного агента
   * (`/api/chat/:chatId/main-agent`).
   */
  chatId: string(),
  /** Стадия звена группы: `work`, `review`, `fix`, `deliver`; нет — обычный чат. */
  stage: string().optional(),
  /** Сессия, на которой разговор сейчас. */
  current: boolean().optional(),
  /** Первая и последняя запись транскрипта (ISO). */
  startedAt: string().optional(),
  endedAt: string().optional(),
  main: agentHistoryMainSchema,
  /** Субагенты сессии деревом (`parentId`), как в «Плане агента». */
  agents: array(progressAgentSchema),
  /** Странности субагентов по `agentId` — только у тех, у кого они есть. */
  anomalies: record(string(), agentAnomaliesSchema).optional(),
  /**
   * Главный агент этой сессии работает прямо сейчас — то же правило, что у
   * `live.agents`: число сессий с этой отметкой и есть `live.agents`. Сервер
   * шлёт обе отметки всегда; нет их — ответ сервера, который их ещё не знал.
   */
  liveMain: boolean().optional(),
  /** `id` субагентов сессии, работающих сейчас; их число по сессиям = `live.subagents`. */
  liveAgents: array(string()).optional(),
});

export type AgentHistorySession = Infer<typeof agentHistorySessionSchema>;

/**
 * Кто работает прямо сейчас — по транскриптам и реестру процессов панели.
 * Главный агент — ход открыт и процесс жив (или файл писался недавно);
 * субагент — итога нет и его файл писался недавно (`LIVE_STALE_MS`).
 */
export const agentHistoryLiveSchema = object({
  agents: number(),
  subagents: number(),
});

export type AgentHistoryLive = Infer<typeof agentHistoryLiveSchema>;

export { LIVE_STALE_MS, MAIN_AGENT_ID } from './agent-live.ts';

export const agentHistorySchema = object({
  /** Новые первыми. */
  sessions: array(agentHistorySessionSchema),
  /** Субагентов во всех сессиях. */
  agentCount: number(),
  live: agentHistoryLiveSchema,
});

export type AgentHistory = Infer<typeof agentHistorySchema>;
