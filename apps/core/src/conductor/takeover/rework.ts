import { openMrUnitOf } from './target.ts';
import type { ReworkPort, ReworkSource, TakeoverRefusal } from './takeover.types.ts';

/**
 * Доработка законченной задачи (P162, D10): только `done` с открытым MR, и тогда — один носитель
 * ответов через порт. Одна функция для двух дорог: команда живой задачи (`commands/rework.ts`) и
 * суд API до открытия закрытой (`api/command-gate.ts`) — законченную задачу ядро не возобновляет,
 * строк после её `task.ended` не пишет, поэтому повтор держит ключ оценки носителя, а не журнал
 * источника.
 */

export const REWORK_STATES = 'running, or done with an open MR';

const refused = (reason: string): TakeoverRefusal => ({
  ok: false,
  code: 'state-conflict',
  reason: `${reason}; rework applies to ${REWORK_STATES}`,
});

export async function reworkDone(
  source: ReworkSource,
  cmdId: string,
  text: string,
  port: ReworkPort | undefined,
): Promise<{ ok: true; carrierTaskId: string } | TakeoverRefusal> {
  const { state } = source;
  if (state.ended !== 'done') return refused(`task is ${state.ended ?? state.task}`);
  if (!openMrUnitOf(state)) return refused('task is done without an open MR');
  if (!port) return { ok: false, code: 'rework-unwired', reason: 'rework wiring is not connected' };
  return port.carrier(source, cmdId, text);
}

/** Отказ «не то состояние» для идущей задачи без живого шага — тем же текстом состояний. */
export function reworkConflict(reason: string): TakeoverRefusal {
  return refused(reason);
}
