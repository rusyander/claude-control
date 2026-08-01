import { basename } from 'node:path';
import type { SlashCommand } from '@claude-control/contracts';
import { listFiles } from './io.ts';
import { readMdCommand, readTomlCommand } from './parse.ts';

/**
 * Файлы команд каталога → записи списка. Общая часть для Claude и остальных
 * CLI: различаются только расширение, разделитель пространства имён и владелец.
 */
export function commandFiles(
  dir: string,
  extension: 'md' | 'toml',
  separator: string | undefined,
  meta: { source: 'command' | 'plugin'; owner: string; prefix?: string },
): SlashCommand[] {
  const files = listFiles(dir, `.${extension}`, separator !== undefined);
  return files.map((file) => {
    const segments = file.relative.split('/');
    const name = segments
      .map((segment, index) =>
        index === segments.length - 1 ? basename(segment, `.${extension}`) : segment,
      )
      .join(separator ?? '');
    const parsed = extension === 'toml' ? readTomlCommand(file.path) : readMdCommand(file.path);
    const invocation = meta.prefix ? `/${meta.prefix}:${name}` : `/${name}`;

    return {
      id: `${meta.source}:${invocation}`,
      invocation,
      name,
      source: meta.source,
      description: parsed.description,
      owner: meta.owner,
      path: file.path,
      isEnabled: true,
      ...(parsed.argumentHint ? { argumentHint: parsed.argumentHint } : {}),
      aliases: [],
      related: [],
      target: meta.source === 'plugin' ? ('plugin' as const) : ('none' as const),
    };
  });
}

/** Порядок — по вызову: список читают глазами, и алфавит здесь единственный понятный. */
export function sortCommands(commands: SlashCommand[]): SlashCommand[] {
  return [...commands].sort((a, b) => a.invocation.localeCompare(b.invocation));
}
