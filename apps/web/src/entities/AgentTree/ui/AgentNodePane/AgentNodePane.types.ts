export interface AgentNodePaneProps {
  /** Разговор: его узлы ядра — по `conversationId`. */
  chatId: string;
  /** Узел ядра: у субагента — `toolUseId` вызова `Agent` (он же `id` строки «Плана агента»). */
  agentId: string;
  /** Закрыть панель (и вернуть фокус строке, с которой её открыли). */
  onClose: () => void;
}
