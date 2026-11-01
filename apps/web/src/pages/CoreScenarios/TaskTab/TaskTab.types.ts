import type { Scenario } from '@agentdeck/contracts/core/scenario';

export interface TaskTabProps {
  library: Scenario[];
  /** Задача из адреса (`?id=`). */
  taskId: string | undefined;
  onPick: (taskId: string) => void;
}
