import type { ProgressAgent } from '@agentdeck/contracts';
import type { AgentNode } from '@agentdeck/contracts/core/agents';

/**
 * Что стало с субагентом — с поправкой на процесс разговора: `lost` — процесс
 * умер, пока субагент «работал»; `stopped` — его сняли по просьбе (`killed`).
 */
export type AgentState = ProgressAgent['status'] | 'lost' | 'stopped';

/**
 * Субагент «Плана агента»: вызов из транскрипта главного разговора плюс то, что знает о нём
 * ядро (`withCoreFacts`). Поля ядра необязательны: ядро не ответило или узла у него нет —
 * строка остаётся такой, какой её прислал сервер.
 */
export interface TreeAgent extends ProgressAgent {
  /** Узел, запустивший этого субагента (вызов `Agent` другого субагента); нет — главный агент. */
  parentId?: string;
  /** Модель субагента по журналу ядра. */
  model?: string;
  /** Сколько вызовов инструментов сделал субагент. */
  toolCalls?: number;
  /** Расход субагента в токенах; нет — ядро его не знает (не ноль). */
  spendTokens?: number;
  /** Когда закончил (ISO). */
  endedAt?: string;
  /**
   * Тип узла ядра у строки, которую знает только ядро (`kind` у неё — код ядра, а не имя агента
   * из транскрипта): строка подписывается словарём типов, а не сырым `subagent`.
   */
  coreKind?: AgentNode['kind'];
}

/** Узел дерева: субагент и те, кого запустил он сам. */
export interface AgentTreeNode {
  agent: TreeAgent;
  /** Глубина от главного агента: 1 — его прямой субагент. */
  level: number;
  children: AgentTreeNode[];
}

/** Открытый справа ход субагента — какого разговора и какого агента. */
export interface AgentPaneTarget {
  chatId: string;
  agentId: string;
}
