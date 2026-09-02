/**
 * Статус агента в проекте — то, что показывает цветная точка на табе и в списке.
 *
 *   running (зелёная) — агент сейчас работает;
 *   quiet   (серая)   — агент работает, но событий нет уже долго: стоит взглянуть;
 *   waiting (жёлтая)  — агент задал вопрос и ждёт ответа человека;
 *   error   (красная) — лимит или ошибка;
 *   idle              — ничего не происходит, точки нет.
 *
 * Логика вынесена в чистые функции: их покрываем тестами, а стор и интерфейс
 * лишь пользуются результатом.
 */
export type RunStatus = 'idle' | 'running' | 'quiet' | 'waiting' | 'error';

/** Насколько статус «важен» для показа: у проекта берём самый тревожный. */
const SEVERITY: Record<RunStatus, number> = {
  idle: 0,
  quiet: 1,
  // Работающий заметнее молчащего: пока в проекте кто-то работает, таб
  // зелёный — молчащего видно по его собственной точке в списке разговоров.
  running: 2,
  waiting: 3,
  error: 4,
};

/**
 * Сколько молчания при живом прогоне считать «тихо» (мс).
 *
 * Пять минут, а не две: длинный вызов инструмента — сборка, прогон тестов,
 * subagent — молчит именно столько, и красная точка на нём читалась как «упал»,
 * хотя процесс жив. Молчание — не ошибка: точка серая, прогон по-прежнему
 * считается идущим, а «упал» говорит только сам сервер событием error.
 */
export const STALL_MS = 300_000;

/**
 * Статус одного прогона с поправкой на молчание: агент «работает», но событий
 * нет дольше STALL_MS — показываем серым, чтобы на него взглянули.
 */
export function runStatus(run: {
  status: RunStatus;
  lastEventAt: number;
  now: number;
  /** Агент ждёт разрешения инструмента — это «нужен ответ», хоть процесс и жив. */
  pendingPermission?: boolean;
}): RunStatus {
  if (run.status === 'running' && run.pendingPermission) return 'waiting';
  if (run.status === 'running' && run.now - run.lastEventAt > STALL_MS) return 'quiet';
  return run.status;
}

/** Прогон жив: работает, пусть даже молча. */
export function isLive(status: RunStatus): boolean {
  return status === 'running' || status === 'quiet';
}

/** Итоговый статус проекта — самый тревожный среди его прогонов. */
export function aggregateStatus(statuses: RunStatus[]): RunStatus {
  return statuses.reduce<RunStatus>(
    (worst, status) => (SEVERITY[status] > SEVERITY[worst] ? status : worst),
    'idle',
  );
}

/** Тон точки для дизайн-системы. idle → точки нет. */
export function statusTone(
  status: RunStatus,
): 'success' | 'neutral' | 'warning' | 'danger' | undefined {
  switch (status) {
    case 'running':
      return 'success';
    case 'quiet':
      return 'neutral';
    case 'waiting':
      return 'warning';
    case 'error':
      return 'danger';
    default:
      return undefined;
  }
}
