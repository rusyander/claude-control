import type { QueuedMessage } from '@shared/lib/agent-runs';

export interface QueuedBubblesProps {
  /** Дописанное, ждущее конца текущего хода, — в порядке отправки. */
  items: QueuedMessage[];
  /** Передумал: убрать это сообщение из очереди, пока оно не ушло. */
  onCancel?: (queuedId: string) => void;
  /**
   * Очередь стоит: ход остановили или панель перезапускалась, и сама она не
   * уйдёт (Ф13). Первое сообщение подписано «Ждёт отправки» и несёт кнопку.
   */
  held?: boolean;
  /** «Отправить» у первого ждущего сообщения. */
  onSend?: (queuedId: string) => void;
}
