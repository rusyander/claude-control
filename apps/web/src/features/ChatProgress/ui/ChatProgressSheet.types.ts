import type { ChatProgress, ProgressAgent, ProgressTask } from '@claude-control/contracts';

export interface ChatProgressSheetProps {
  progress?: ChatProgress;
  /** Агент ещё работает — показываем это в шапке панели. */
  isRunning?: boolean;
}

export interface TaskRowProps {
  task: ProgressTask;
}

export interface AgentRowProps {
  agent: ProgressAgent;
}
