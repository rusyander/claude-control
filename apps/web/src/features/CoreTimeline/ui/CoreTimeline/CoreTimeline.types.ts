import type { TaskView } from '@agentdeck/contracts/core/task-view';
import type { TimelineFold } from '../../model/fold.types';

export interface CoreTimelineProps {
  taskId: string;
  fold: TimelineFold;
  view: TaskView | undefined;
}
