import type { QueuedMessage } from './agent-runs.types';

export interface StoredQueue {
  savedAt: number;
  items: QueuedMessage[];
}
