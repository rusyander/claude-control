import type { CommandRow } from './commandView.types';

/**
 * Поиск по всему, что человек может помнить: имя, вызов, описание, владелец,
 * другие имена той же команды. Запрос со слэшем ищется так же, как без него —
 * набирать команду привычно именно со слэшем.
 */
export function filterCommands(rows: CommandRow[], query: string): CommandRow[] {
  const needle = query.trim().toLowerCase().replace(/^\//, '');
  if (!needle) return rows;

  return rows.filter((row) =>
    [row.name, row.invocation, row.description, row.owner ?? '', ...row.aliases]
      .join(' ')
      .toLowerCase()
      .includes(needle),
  );
}
