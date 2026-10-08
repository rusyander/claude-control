import type { QueuedMessage } from './types';

export interface StoredQueue {
  savedAt: number;
  items: QueuedMessage[];
}
