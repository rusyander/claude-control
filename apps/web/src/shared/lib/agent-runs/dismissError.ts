import { cancelAutoRetry } from './agent-runs.retry';
import { rebuildStatuses } from './agent-runs.statuses';
import { emit } from './emit';
import { runs } from './agent-runs.state.constants';
import { findKey } from './findKey';

/**
 * Закрыть карточку ошибки: человек видел беду и решил не повторять. Прогон
 * остаётся (переписка, расход, очередь при нём), уходят ошибка, красная точка
 * и сам упавший запрос: «Повторить» после этого нечего, а запланированный
 * авто-рестарт отменяется, иначе закрытая беда вернулась бы сама.
 */
export function dismissError(id: string): void {
  const key = findKey(id);
  if (!key) return;
  const run = runs.get(key);
  if (!run?.error) return;
  cancelAutoRetry(key);
  runs.set(key, {
    ...run,
    error: undefined,
    errorCode: undefined,
    errorParams: undefined,
    errorOverflow: undefined,
    lastPrompt: undefined,
    status: run.status === 'error' ? 'idle' : run.status,
  });
  rebuildStatuses();
  emit();
}
