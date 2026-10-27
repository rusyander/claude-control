import type {
  AgentAnomalies,
  AgentStep,
  ProgressActiveTool,
  ProgressAgent,
} from '@agentdeck/contracts';
import type { ExtensionSnapshot } from './extension-trail.ts';

/** Расход субагента: каждый ответ модели — один раз. */
export interface AgentTokens {
  input: number;
  output: number;
  cacheRead: number;
  cacheCreation: number;
}

/** Всё, что панель знает о субагенте по его собственному транскрипту. */
export interface AgentDigest {
  /** Последняя модель, ответившая за субагента. */
  model?: string;
  /** Задание — первая реплика его транскрипта, одной строкой. */
  prompt?: string;
  startedAt?: string;
  lastAt?: string;
  toolCalls: number;
  tokens: AgentTokens;
  lastAction?: string;
  /** Последний вызов без результата — субагент занят им сейчас. */
  openTool?: ProgressActiveTool;
  /** Ход окончен: последний ответ — реплика без вызовов, открытых вызовов нет. */
  ended: boolean;
  /** Субагенты, которых запустил он сам, — по его вызовам `Agent`/`Task`. */
  children: ProgressAgent[];
  steps: AgentStep[];
  /** Скиллы, хуки и MCP — срабатывания по времени и сводка по именам. */
  extensions: ExtensionSnapshot;
  /** Отказы хуков, ошибки, повторные чтения, большие результаты — по всему файлу. */
  anomalies: AgentAnomalies;
}
