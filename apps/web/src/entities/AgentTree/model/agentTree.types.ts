import type { ProgressAgent } from '@agentdeck/contracts';

/**
 * Что стало с субагентом — с поправкой на процесс разговора: `lost` — процесс
 * умер, пока субагент «работал»; `stopped` — его сняли по просьбе (`killed`).
 */
export type AgentState = ProgressAgent['status'] | 'lost' | 'stopped';

/** Узел дерева: субагент и те, кого запустил он сам. */
export interface AgentTreeNode {
  agent: ProgressAgent;
  /** Глубина от главного агента: 1 — его прямой субагент. */
  level: number;
  children: AgentTreeNode[];
}

/** Счёт для карточки группы: сколько идёт и сколько уже закончило. */
export interface AgentCounts {
  total: number;
  running: number;
  /** Закончили любым исходом: готово, упал, остановлен, оборван. */
  finished: number;
}

/** Открытый справа ход субагента — какого разговора и какого агента. */
export interface AgentPaneTarget {
  chatId: string;
  agentId: string;
}
