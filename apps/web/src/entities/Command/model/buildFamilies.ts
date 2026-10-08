import type { SlashCommand } from '@agentdeck/contracts';
import { rawFamilyKey } from './rawFamilyKey';

/**
 * Семьи: у команд плагина ключ — сам плагин, у остальных — первое слово имени
 * (`design-sync` → `design`). Семья из одного — не семья, такие ключи
 * выбрасываем: подпись «в семье: —» ничего не сообщает.
 */
export function buildFamilies(commands: SlashCommand[]): Map<string, string[]> {
  const families = new Map<string, string[]>();

  for (const command of commands) {
    const key = rawFamilyKey(command);
    if (!key) continue;
    families.set(key, [...(families.get(key) ?? []), command.invocation]);
  }

  for (const [key, members] of families) {
    if (members.length < 2) families.delete(key);
  }
  return families;
}
