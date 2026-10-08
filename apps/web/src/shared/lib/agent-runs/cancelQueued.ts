import { persistQueue } from './persistQueue';
import { emit } from './emit';
import { runs } from './agent-runs.state.constants';
import { findKey } from './findKey';

/** Передумал — убрать дописанное из очереди, пока оно ещё не ушло агенту. */
export function cancelQueued(id: string, queuedId: string): void {
  const key = findKey(id);
  if (!key) return;
  const run = runs.get(key);
  if (!run) return;
  runs.set(key, { ...run, queued: run.queued.filter((item) => item.id !== queuedId) });
  persistQueue(key);
  emit();
}
