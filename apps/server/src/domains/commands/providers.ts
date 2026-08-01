import type { SlashCommand } from '@claude-control/contracts';
import type { ConfigProvider } from '../../providers/types.ts';
import { isDirectory, readJson } from './io.ts';
import { commandFiles, sortCommands } from './list.ts';
import { trim } from './parse.ts';

/**
 * Команды остальных CLI. Берём ровно то, что описано в их документации
 * (`commandsConfig` в каталоге провайдеров): формата в документации нет →
 * возможность `unsupported`, раздел скрыт — угадывать чужие пути нельзя.
 */
export function readProviderCommands(provider: ConfigProvider): {
  commands: SlashCommand[];
  notes: string[];
} {
  const config = provider.commandsConfig;
  if (!config) return { commands: [], notes: [] };

  const notes: string[] = [];
  const dir = config.dir();
  if (!isDirectory(dir)) notes.push(`Каталог команд не найден: ${dir}.`);

  const commands = commandFiles(
    dir,
    config.format === 'toml-prompt' ? 'toml' : 'md',
    config.namespaceSeparator,
    { source: 'command', owner: provider.name },
  );

  return {
    commands: sortCommands([...commands, ...configCommands(config.configPath?.(), provider.name)]),
    notes,
  };
}

/**
 * Команды, объявленные ключом в самом конфиге (OpenCode: `command`), — второй
 * задокументированный источник. Без него список показал бы половину правды.
 */
function configCommands(path: string | undefined, owner: string): SlashCommand[] {
  if (!path) return [];
  const config = readJson(path) as { command?: Record<string, unknown> } | undefined;
  const entries = config?.command;
  if (!entries || typeof entries !== 'object') return [];

  return Object.entries(entries).map(([name, value]) => {
    const entry = (value ?? {}) as { description?: unknown };

    return {
      id: `command:/${name}`,
      invocation: `/${name}`,
      name,
      source: 'command' as const,
      description: typeof entry.description === 'string' ? trim(entry.description) : '',
      owner,
      path,
      isEnabled: true,
      aliases: [],
      related: [],
      target: 'none' as const,
    };
  });
}
