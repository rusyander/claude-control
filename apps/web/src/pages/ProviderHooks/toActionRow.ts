import type { ProviderHookAction } from '@agentdeck/contracts';
import type { ActionRow } from './ProviderHooks.types';
import { nextRowId } from './ProviderHooks.lib';

/** Ответ сервера → состояние формы. */
export function toActionRow(action: ProviderHookAction): ActionRow {
  return {
    id: nextRowId(),
    command: action.command.map((value) => ({ id: nextRowId(), value })),
    env: (action.environment ?? []).map((pair) => ({
      id: nextRowId(),
      key: pair.key,
      value: pair.value,
    })),
  };
}
