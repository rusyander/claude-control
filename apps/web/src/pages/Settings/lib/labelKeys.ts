import type { GroupRequestId } from '@agentdeck/contracts/split-groups';

/**
 * Подпись строки: «обычная работа» — своя, у именованных правил — те же слова,
 * что в меню прав чата, чтобы одно правило не называлось двумя именами.
 */
export function labelKeys(id: GroupRequestId): { label: string; hint: string } {
  return id === 'routine'
    ? { label: 'settings.groups.routine', hint: 'settings.groups.routineHint' }
    : { label: `chat.rules.${id}`, hint: `chat.rules.${id}Hint` };
}
