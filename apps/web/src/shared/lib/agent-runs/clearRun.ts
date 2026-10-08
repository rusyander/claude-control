import { controllers } from './agent-runs.state';
import { rebuildStatuses } from './agent-runs.statuses';
import { emit } from './emit';
import { runs } from './agent-runs.state.constants';
import { findKey } from './findKey';

/** Убрать прогон из стора (например, когда его ответ уже есть в истории). */
export function clearRun(id: string): void {
  const key = findKey(id);
  if (!key) return;
  controllers.get(key)?.abort();
  controllers.delete(key);
  runs.delete(key);
  rebuildStatuses();
  emit();
}
