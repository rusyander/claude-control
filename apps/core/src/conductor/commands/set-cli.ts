import type { COMMAND_FIELDS } from '@agentdeck/contracts/core/commands';
import type { z } from 'zod';
import type { ApplyCommand } from './commands.types.ts';
import { applyOverride } from './set-model.ts';

/**
 * Смена CLI (G9): правка переходника уровня строкой `override.set`; тот же суд набора, что у
 * `set-model` (`applyOverride`).
 */
export const applySetCli: ApplyCommand = async (task, command) => {
  const f = command.fields as z.infer<(typeof COMMAND_FIELDS)['set-cli']>;
  return applyOverride(task, command.cmdId, f, [{ field: 'adapter', value: f.adapter }]);
};
