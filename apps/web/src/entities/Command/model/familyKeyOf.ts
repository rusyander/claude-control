import type { SlashCommand } from '@agentdeck/contracts';
import { rawFamilyKey } from './rawFamilyKey';

export function familyKeyOf(
  command: SlashCommand,
  families: Map<string, string[]>,
): string | undefined {
  const key = rawFamilyKey(command);
  return key && families.has(key) ? key : undefined;
}
