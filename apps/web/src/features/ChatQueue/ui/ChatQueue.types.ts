import type { QueuedMessage } from '@shared/lib/agent-runs';

export interface ChatQueueProps {
  /** Дописанное, что уйдёт агенту, когда он закончит текущий ход. */
  items: QueuedMessage[];
  /** Убрать сообщение из очереди — пока оно ещё не ушло. */
  onCancel: (id: string) => void;
}
