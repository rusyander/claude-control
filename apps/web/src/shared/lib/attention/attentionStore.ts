/**
 * Какие поводы человек уже видел. Живёт в памяти вкладки: закрыл страницу —
 * поводы снова свежие, и это правильно. В localStorage такому не место: вернуться
 * через час и не увидеть, что агент всё ещё ждёт, хуже лишнего сигнала.
 */

const dismissed = new Map<string, string>();
const listeners = new Set<() => void>();

/** Снимок для useSyncExternalStore: новая ссылка только когда карта менялась. */
let snapshot: ReadonlyMap<string, string> = new Map();

function emit(): void {
  snapshot = new Map(dismissed);
  for (const listener of listeners) listener();
}

export function getDismissed(): ReadonlyMap<string, string> {
  return snapshot;
}

export function subscribeDismissed(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Человек увидел этот повод: пометку снимаем, пока статус прогона тот же. */
export function dismissAttention(runId: string | undefined, status: string): void {
  if (!runId) return;
  if (dismissed.get(runId) === status) return;
  dismissed.set(runId, status);
  emit();
}

/** Только для тестов: вернуть хранилище в исходное состояние. */
export function resetDismissed(): void {
  dismissed.clear();
  emit();
}
