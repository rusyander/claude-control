import type { CommandRow, CommandFilter } from './commandView.types';

/** Сколько команд каждого источника — для подписей на фильтрах. */
export function countBySource(rows: CommandRow[]): Record<CommandFilter, number> {
  const counts: Record<CommandFilter, number> = {
    all: rows.length,
    builtin: 0,
    skill: 0,
    command: 0,
    plugin: 0,
  };
  for (const row of rows) counts[row.source] += 1;
  return counts;
}
