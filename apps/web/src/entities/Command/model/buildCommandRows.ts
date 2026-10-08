import type { SlashCommand } from '@agentdeck/contracts';
import type { CommandLocale, CommandRow } from './commandView.types';
import { BUILTIN_COMMANDS } from './builtinCommands';
import { builtinRows } from './commandView';
import { buildFamilies } from './buildFamilies';
import { familyKeyOf } from './familyKeyOf';

/**
 * Собрать список для показа: встроенные + прочитанные с диска, с посчитанными
 * семьями. Совпадение по вызову решается в пользу файла: если у человека есть
 * свой `/doctor`, показывать надо ЕГО, а не одноимённую встроенную.
 */
export function buildCommandRows(
  fromDisk: SlashCommand[],
  locale: CommandLocale,
  includeBuiltins = true,
): CommandRow[] {
  const seen = new Set(fromDisk.map((command) => command.invocation));
  const builtins = includeBuiltins
    ? builtinRows(locale).filter((command) => !seen.has(command.invocation))
    : [];

  const merged = [...fromDisk, ...builtins];
  const meta = new Map(BUILTIN_COMMANDS.map((command) => [command.name, command]));
  const families = buildFamilies(merged);

  return merged
    .map((command): CommandRow => {
      const builtin = command.source === 'builtin' ? meta.get(command.name) : undefined;
      const familyKey = familyKeyOf(command, families);
      const family = familyKey
        ? (families.get(familyKey) ?? []).filter((item) => item !== command.invocation)
        : [];

      return {
        ...command,
        isBuiltin: command.source === 'builtin',
        ...(builtin ? { builtinKind: builtin.kind } : {}),
        ...(builtin?.removed ? { isRemoved: true } : {}),
        ...(familyKey && family.length > 0 ? { familyKey } : {}),
        family,
      };
    })
    .sort((a, b) => a.invocation.localeCompare(b.invocation));
}
