import type { CheckView } from '@agentdeck/contracts/core/task-view';

export interface CheckEntryProps {
  taskId: string;
  check: Pick<CheckView, 'mode' | 'why' | 'recordId'>;
  outcome: string | null;
  reasons: string[];
}
