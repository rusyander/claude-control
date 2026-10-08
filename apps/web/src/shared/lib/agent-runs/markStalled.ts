import { runs } from './agent-runs.state.constants';
import { setRun } from './setRun';
import { emit } from './emit';

/**
 * Пометить прогон замолчавшим. Метка нужна ленте: пока она стоит, потоковый
 * пузырь с оборванного хода не показывается, а история перестаёт прятать этот
 * ход — иначе ответ, уже дописанный в транскрипт, остаётся невидимым.
 */
export function markStalled(id: string): void {
  if (!runs.get(id)) return;
  setRun(id, { stalled: true });
  emit();
}
