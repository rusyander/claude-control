import type { ActionRow } from './ProviderHooks.types';
import { nextRowId } from './ProviderHooks.lib';

/** Пустое действие с одной строкой команды — так форма сразу пригодна для ввода. */
export function emptyActionRow(): ActionRow {
  return { id: nextRowId(), command: [{ id: nextRowId(), value: '' }], env: [] };
}
