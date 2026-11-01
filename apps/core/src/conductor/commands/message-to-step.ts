import { STEP_MACHINE } from '@agentdeck/contracts/core/states';
import type { ApplyCommand } from './commands.types.ts';
import { applied, reject } from './outcome.ts';

/**
 * Сообщение шагу (02 §User interventions, F26): команда только принимает текст — он лежит в
 * `command.received`, а `command.applied` делает его сообщением. Доставку на ближайшей границе
 * хода сессии шага делает `conductor/human/deliver.ts` (`message.delivered` ровно раз). Шаг,
 * которого нет или который кончился, сообщения не примет: доставлять его некому.
 */
export const applyMessageToStep: ApplyCommand = async (task, command) => {
  const { stepId } = command.fields as { stepId: string; text: string };
  const step = task.state.steps[stepId];
  if (!step) return reject(task, command.cmdId, 'unknown-step', `no step ${stepId} in this task`);
  if ((STEP_MACHINE.terminal as readonly string[]).includes(step.state)) {
    return reject(task, command.cmdId, 'step-ended', `step ${stepId} is ${step.state}`);
  }
  return applied(task, command.cmdId, { stepId, delivery: 'next-turn-boundary' });
};
