/**
 * Номера живых процессов CLI, запущенных панелью: чат, агент панели, чат чужого
 * CLI, агент тестов, наблюдатель. Решение человека, пришедшее от потомка любого
 * из них, — решение модели (`routes/chat/human-only/human-only.ts`); реестр
 * прогонов знает только чаты Claude, а `curl` на маршрут решения есть у любого
 * агента с оболочкой.
 */

const live = new Set<number>();

interface Exiting {
  pid?: number | undefined;
  once?: (event: 'exit', listener: () => void) => unknown;
}

/** Запомнить процесс до его выхода. Без номера (запуск упал) — ничего. */
export function trackCliPid(child: Exiting): void {
  const pid = child.pid;
  if (typeof pid !== 'number' || pid <= 0) return;
  live.add(pid);
  child.once?.('exit', () => live.delete(pid));
}

export function liveCliPids(): number[] {
  return [...live];
}
