import type { CommandRow, CommandFilter } from './commandView.types';

export function filterBySource(rows: CommandRow[], filter: CommandFilter): CommandRow[] {
  return filter === 'all' ? rows : rows.filter((row) => row.source === filter);
}
