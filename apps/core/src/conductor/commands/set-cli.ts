import type { COMMAND_FIELDS } from '@agentdeck/contracts/core/commands';
import type { z } from 'zod';
import { compatAdapterGate } from '../../routes/compat/compat.ts';
import type { ApplyCommand } from './commands.types.ts';
import { reject } from './outcome.ts';
import { applyOverride } from './set-model.ts';

/**
 * Смена CLI (G9): правка переходника уровня строкой `override.set`; тот же суд набора, что у
 * `set-model` (`applyOverride`). Раньше набора — суд совместимости по самому переходнику
 * (W3-17a): CLI без хука и оверлея (aider, continue) отказан своим кодом `no_core_hook`, и
 * человек видит названную причину, а не «вне набора» без контура. CLI, прошедший этот суд, но
 * не входящий в набор, по-прежнему отказан `outside-allowed-set`.
 */
export const applySetCli: ApplyCommand = async (task, command, env) => {
  const f = command.fields as z.infer<(typeof COMMAND_FIELDS)['set-cli']>;
  const adapter = env.adapterOf?.(f.adapter);
  const gate = adapter ? compatAdapterGate(adapter) : null;
  if (gate) {
    const why =
      gate === 'no_core_hook'
        ? 'has neither a pre-tool hook nor a deny overlay'
        : 'is a placeholder adapter, not built';
    return reject(task, command.cmdId, gate, `compat refused: ${gate} — ${f.adapter} ${why}`);
  }
  return applyOverride(task, command.cmdId, f, [{ field: 'adapter', value: f.adapter }]);
};
