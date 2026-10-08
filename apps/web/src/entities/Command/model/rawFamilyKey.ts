import type { SlashCommand } from '@agentdeck/contracts';

export function rawFamilyKey(command: SlashCommand): string | undefined {
  if (command.source === 'plugin') return command.owner;
  const head = command.name.split(/[-:]/)[0];
  return head && head.length > 1 ? head : undefined;
}
