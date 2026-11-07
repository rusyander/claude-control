import type {
  AgentKind,
  AgentStatus,
  AgentToolCall,
  BgItem,
} from '@agentdeck/contracts/core/agents';
import type { JournalLine } from '@agentdeck/contracts/core/journal';
import type { TaskClass } from '@agentdeck/contracts/core/scenario';

/** Вызов инструмента узла: `tool.started` + `tool.event` того же `toolUseId`. */
export interface CallAcc extends AgentToolCall {
  nodeId: string;
  /** Класс действия из `tool.event` (`read`, `edit`, …); `null` — конца вызова ещё нет. */
  effectClass: string | null;
}

/** Узел в свёртке: поля вида плюс то, из чего вид считается при показе. */
export interface NodeAcc {
  nodeId: string;
  parentId: string | null;
  kind: AgentKind;
  status: AgentStatus;
  stepId: string | null;
  unitId: string | null;
  sessionId: string | null;
  model: string | null;
  effort: string | null;
  background: boolean;
  startedAt: number;
  endedAt: number | null;
  /** Расход по сообщениям (`sessionId|messageId` → токены бюджета): повтор строки заменяет. */
  usage: Map<string, number>;
  /** Итог CLI на конце субагента (`agent.ended.usage.totalTokens`); `null` — не назван. */
  endTokens: number | null;
  /** Доля окна по последней строке расхода, где сессия назвала окно; `null` — неизвестно. */
  windowShare: number | null;
  calls: string[];
  files: string[];
  refusals: { toolUseId: string; code: string; reason: string }[];
  signals: string[];
  briefExcerpt: string | null;
  returnExcerpt: string | null;
  /** Только у фоновой работы — строка `bg.started` (+ конец). */
  bg: BgItem | null;
  /** Номер строки `bg.started` — вход решения сигнала фона. */
  startSeq: number;
}

/** Строка расхода, назвавшая вызов субагента, которого сессия не запускала (P149). */
export interface MisattributedUsage {
  sessionId: string;
  parentToolUseId: string;
  seqs: number[];
  tokens: number;
}

/** Сессия единицы: шаг, хост и как кончилась. */
export interface SessionAcc {
  sessionId: string;
  stepId: string;
  host: { pid: number; start: string } | null;
  ended: boolean;
}

export interface EscalationAcc {
  from: string;
  to: string;
  cause: string;
}

/**
 * Свёртка истории агентов задачи (P146): только строки журнала, транскрипты CLI не читаются.
 * Изменяемая — её ведёт один владелец (проводка или поток), строка за строкой по `seq`.
 */
export interface AgentsFold {
  taskId: string;
  seq: number;
  class: TaskClass | null;
  groupId: string | null;
  conversationId: string | null;
  taskEnded: boolean;
  nodes: Map<string, NodeAcc>;
  calls: Map<string, CallAcc>;
  sessions: Map<string, SessionAcc>;
  /** Шаг → единица, вид шага (из `step.started`). */
  steps: Map<string, { unitId: string; stepKind: string }>;
  /** Шаг → подъёмы ступени (решения `tier` с источником `escalation`). */
  escalations: Map<string, EscalationAcc[]>;
  /** Последняя ступень по единице и виду шага: «откуда» следующего подъёма. */
  lastRung: Map<string, string>;
  /** Строки расхода с неизвестным родителем: ждут `agent.spawned`, иначе — чужой расход. */
  pending: Map<string, MisattributedUsage & { usage: Map<string, number> }>;
  /** Строки конца (`agent.ended`/`bg.ended`), пришедшие раньше начала своего узла: ждут его. */
  early: Map<string, JournalLine>;
  /**
   * Отказы разрешения, пришедшие раньше `tool.started` своего вызова: id вызова → узел, где отказ
   * лежит временно (сеанс). Начало вызова переносит его в узел вызова.
   */
  strays: Map<string, string>;
  /** Ключи решений наблюдателя, уже вынесенных (повтор после перезапуска не пишется). */
  decided: Set<string>;
}
