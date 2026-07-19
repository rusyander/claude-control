/**
 * Статус агента в проекте — то, что показывает цветная точка на табе и в списке.
 *
 *   running (зелёная) — агент сейчас работает;
 *   waiting (жёлтая)  — агент задал вопрос и ждёт ответа человека;
 *   error   (красная) — лимит, ошибка или зависание (агент замолчал надолго);
 *   idle              — ничего не происходит, точки нет.
 *
 * Логика вынесена в чистые функции: их покрываем тестами, а стор и интерфейс
 * лишь пользуются результатом.
 */
export type RunStatus = 'idle' | 'running' | 'waiting' | 'error';

/** Насколько статус «важен» для показа: у проекта берём самый тревожный. */
const SEVERITY: Record<RunStatus, number> = { idle: 0, running: 1, waiting: 2, error: 3 };

/** Точка молчит слишком долго при активном прогоне → считаем зависанием (мс). */
export const STALL_MS = 120_000;

/**
 * Статус одного прогона с поправкой на зависание: если агент «работает», но
 * событий нет дольше STALL_MS, показываем это красным, а не зелёным.
 */
export function runStatus(run: { status: RunStatus; lastEventAt: number; now: number }): RunStatus {
  if (run.status === 'running' && run.now - run.lastEventAt > STALL_MS) return 'error';
  return run.status;
}

/** Итоговый статус проекта — самый тревожный среди его прогонов. */
export function aggregateStatus(statuses: RunStatus[]): RunStatus {
  return statuses.reduce<RunStatus>(
    (worst, status) => (SEVERITY[status] > SEVERITY[worst] ? status : worst),
    'idle',
  );
}

/** Тон точки для дизайн-системы. idle → точки нет. */
export function statusTone(status: RunStatus): 'success' | 'warning' | 'danger' | undefined {
  switch (status) {
    case 'running':
      return 'success';
    case 'waiting':
      return 'warning';
    case 'error':
      return 'danger';
    default:
      return undefined;
  }
}
