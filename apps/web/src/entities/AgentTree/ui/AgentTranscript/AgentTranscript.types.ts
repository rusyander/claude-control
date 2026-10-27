import type { AgentStep } from '@agentdeck/contracts';

export interface AgentTranscriptProps {
  chatId: string;
  agentId: string;
  /** Закрыть панель (и вернуть фокус узлу дерева). */
  onClose: () => void;
}

export interface AgentStepRowProps {
  step: AgentStep;
}
