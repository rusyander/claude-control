import { STEP_MACHINE } from '@agentdeck/contracts/core/states';
import type { ApplyCommand } from './commands.types.ts';
import { applied, reject } from './outcome.ts';

/**
 * Конец чата (этап 10): команда только принимает намерение — `command.applied` с `stepId` в
 * исходе. Сам шаг закрывает дирижёр (`conductor/next/active.ts` видит применённый `end-chat`,
 * `run/perform.ts` `close-chat`): сеанс снимается мягко, шаг сдаётся с основанием `human`.
 * Закрыть можно только шаг чата: у шага работы конец — его проверка, а не слово человека.
 */
export const applyEndChat: ApplyCommand = async (task, command) => {
  const { stepId } = command.fields as { stepId: string };
  const step = task.state.steps[stepId];
  if (!step) return reject(task, command.cmdId, 'unknown-step', `no step ${stepId} in this task`);
  if (step.stepKind !== 'chat') {
    return reject(task, command.cmdId, 'not-a-chat', `step ${stepId} is ${step.stepKind}`);
  }
  if ((STEP_MACHINE.terminal as readonly string[]).includes(step.state)) {
    return reject(task, command.cmdId, 'step-ended', `step ${stepId} is ${step.state}`);
  }
  return applied(task, command.cmdId, { stepId, close: 'next-safe-point' });
};
