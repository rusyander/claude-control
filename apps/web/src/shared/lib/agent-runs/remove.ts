import { PREFIX } from './agent-runs.queue-store.constants';

export function remove(id: string): void {
  try {
    localStorage.removeItem(PREFIX + id);
  } catch {
    // См. комментарий выше: хранилище может быть недоступно.
  }
}
