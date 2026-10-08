import type { SlashCommand } from '@agentdeck/contracts';
import { BUILTIN_COMMANDS } from './builtinCommands';
import type { CommandLocale } from './commandView.types';

/** Встроенные — в тот же вид, что и прочитанные с диска. */
export function builtinRows(locale: CommandLocale): SlashCommand[] {
  return BUILTIN_COMMANDS.map((command) => ({
    id: `builtin:/${command.name}`,
    invocation: `/${command.name}`,
    name: command.name,
    source: 'builtin' as const,
    description: locale === 'ru' ? command.ru : command.en,
    owner: 'Claude Code',
    isEnabled: !command.removed,
    aliases: command.aliases ?? [],
    related: command.related ?? [],
    target: 'none' as const,
  }));
}
