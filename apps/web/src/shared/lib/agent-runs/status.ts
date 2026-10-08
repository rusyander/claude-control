import type { RunStatus } from './status.types';

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
