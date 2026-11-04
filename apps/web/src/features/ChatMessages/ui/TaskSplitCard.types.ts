import type { TaskSplitProposal } from '@agentdeck/contracts/task-split';

export interface TaskSplitCardProps {
  /** Предложение агента, как его разобрала панель. */
  proposal: TaskSplitProposal;
}
