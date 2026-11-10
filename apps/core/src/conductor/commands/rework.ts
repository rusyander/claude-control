import { reworkConflict, reworkDone } from '../takeover/rework.ts';
import { liveStepOf } from '../takeover/target.ts';
import type { ApplyCommand } from './commands.types.ts';
import { applied, reject } from './outcome.ts';

/**
 * Доработка словами человека (P162, D10):
 * - задача идёт → одно сообщение последнему живому шагу (`stepId` в исходе; доставку делает
 *   `human/ledger.ts` + `deliver.ts`, ровно раз на границе хода);
 * - задача кончилась `done` с открытым MR → ровно один носитель ответов с этим текстом (порт
 *   `rework`, ключ оценки = `cmdId`: двойной клик — та же задача). Законченную задачу, которую
 *   ядро уже не держит, API решает до открытия (`api/command-gate.ts`) той же функцией;
 * - остальное → `state-conflict`, названы состояния, где доработка возможна.
 */
export const applyRework: ApplyCommand = async (task, command, env) => {
  const { cmdId } = command;
  const { text } = command.fields as { text: string };
  const state = task.state;
  let got;
  if (state.ended === null && state.task === 'running') {
    const step = liveStepOf(state);
    if (step) return applied(task, cmdId, { stepId: step.stepId, delivery: 'next-turn-boundary' });
    got = reworkConflict('no live step to receive the message');
  } else {
    got = await reworkDone({ taskId: task.taskId, state }, cmdId, text, env.rework?.());
  }
  if (got.ok) return applied(task, cmdId, { carrierTaskId: got.carrierTaskId });
  const result = reject(task, cmdId, got.code, got.reason);
  return got.code === 'state-conflict' ? { ...result, state: task.state } : result;
};
