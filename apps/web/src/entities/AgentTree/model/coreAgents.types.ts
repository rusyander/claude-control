import type { AgentKind, AgentNode, AgentStatus } from '@agentdeck/contracts/core/agents';
import type { TaskClass } from '@agentdeck/contracts/core/scenario';

/** Узел ядра в дереве окна: вложенные — те, чей `parentId` указывает на него в той же задаче. */
export interface CoreTreeNode {
  node: AgentNode;
  /** Глубина от корня: 0 — сеанс единицы или узел без найденного родителя. */
  level: number;
  children: CoreTreeNode[];
}

/**
 * Фильтры окна — те же поля, что у `agentsQuerySchema` ядра; пустое поле — фильтра нет. `groupId`
 * расширяет охват с чата на всю группу задач.
 */
export interface AgentFilters {
  status?: AgentStatus;
  model?: string;
  kind?: AgentKind;
  class?: TaskClass;
  groupId?: string;
}

/**
 * Что показать в строке состояния: состояние ядра с поправкой на сигналы наблюдателя —
 * `orphaned` (владелец умер, работа ещё жива), `hanging` (вывода нет дольше предела).
 */
export type NodeLook = AgentStatus | 'orphaned' | 'orphanLost' | 'hanging';
