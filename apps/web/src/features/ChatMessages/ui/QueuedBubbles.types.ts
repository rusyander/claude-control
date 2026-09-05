import type { QueuedMessage } from '@shared/lib/agent-runs';

export interface QueuedBubblesProps {
  /** Дописанное, ждущее конца текущего хода, — в порядке отправки. */
  items: QueuedMessage[];
  /** Передумал: убрать это сообщение из очереди, пока оно не ушло. */
  onCancel?: (queuedId: string) => void;
}
