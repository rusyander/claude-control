import type { AgentNode, AgentNodeDetail } from '@agentdeck/contracts/core/agents';
import type { AgentFilters, CoreTreeNode } from '../../model/coreAgents.types';

export interface AgentHistoryButtonProps {
  /** Разговор: его задачи ядра находит `conversationId` (новый чат — первый сеанс ядра). */
  chatId: string;
  isRunning: boolean;
  className?: string;
}

export interface AgentHistoryCardProps {
  nodes: readonly AgentNode[];
  onOpen: () => void;
  className?: string;
}

export interface AgentHistoryModalProps {
  chatId: string;
  isOpen: boolean;
  onOpenChange: (isOpen: boolean) => void;
  isRunning: boolean;
}

/** Выбранный узел окна: задача и узел в ней. */
export interface NodePick {
  taskId: string;
  nodeId: string;
}

export interface AgentFiltersBarProps {
  filters: AgentFilters;
  onChange: (filters: AgentFilters) => void;
  /** Модели, встреченные в узлах чата без фильтров. */
  models: readonly string[];
  /** Группы задач чата; пусто — фильтра группы нет. */
  groups: readonly string[];
}

export interface AgentNodeListProps {
  roots: readonly CoreTreeNode[];
  picked: NodePick | undefined;
  onPick: (pick: NodePick) => void;
  now: number;
}

export interface AgentNodeDetailViewProps {
  detail: AgentNodeDetail;
  /** Все узлы чата: родитель узла — по ним. */
  nodes: readonly AgentNode[];
  now: number;
  hasMore: boolean;
  isFetchingMore: boolean;
  onMore: () => void;
}

export interface BgItemDetailProps {
  detail: AgentNodeDetail;
  now: number;
  /** Владелец из списка чата: его аварийный конец делает потерянную работу «осиротевшей». */
  owner?: Pick<AgentNode, 'status'>;
}

export interface AgentNodeDetailProps {
  taskId: string;
  nodeId: string;
  nodes: readonly AgentNode[];
}
