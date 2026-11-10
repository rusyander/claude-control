import type { TaskView } from '@agentdeck/contracts/core/task-view';

export interface CoreWindowOfferProps {
  taskId: string;
  /** Вид задачи: варианты перевода — `view.windowWait.offers` (P169). */
  view: TaskView;
  /** Команда перевода ушла (`set-model` / `set-cli`): вид перечитывается. */
  onDone?: () => void;
}
