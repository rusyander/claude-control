import type { RunStatus } from '@shared/lib/agent-runs';
import type { ChatRowData, ChatListRowsOptions, Row } from '../ui/ChatList/ChatList.types';
import { isLive } from '@shared/lib/agent-runs';
import { withTree } from './withTree';
import { withPinnedFirst } from './withPinnedFirst';
import { withGroupHeaders } from './withGroupHeaders';
import { withActiveFirst } from './withActiveFirst';
import { withAccordion } from './withAccordion';

/** Дети с этими статусами стоят над гармошкой: идёт, ждёт человека, ошибка. */
export const SHOWN: ReadonlySet<RunStatus> = new Set<RunStatus>(['running', 'waiting', 'error']);

/**
 * Строки списка целиком: дерево, поднятые ветви, заголовки, гармошки ветвей.
 * «Идёт» — живой прогон, в том числе замолчавший, или разделение в работе
 * (`inWork`: между стадиями группы прогона нет, а работа идёт).
 *
 * Пока идёт поиск, гармошек нет: найденный разговор обязан быть виден, даже
 * если его ветвь свёрнута, — иначе поиск «ничего не нашёл» при счётчике 1.
 */
export function chatListRows(
  found: ChatRowData[],
  statuses: ReadonlyMap<string, RunStatus> | undefined,
  options: ChatListRowsOptions = {},
): Row[] {
  const working = new Set(found.filter((row) => row.chat.inWork).map((row) => row.chat.id));
  const isActive = (id: string): boolean => {
    const status = statuses?.get(id);
    return working.has(id) || (status !== undefined && isLive(status));
  };
  // Заглушки удалённых родителей — только вне поиска: в поиске сирота стоит
  // там, где его нашли.
  const tree = withTree(found, options.searching ? undefined : options.known);
  const { pinned, rest } = withPinnedFirst(tree);
  const rows = withGroupHeaders([...pinned, ...withActiveFirst(rest, isActive)]);
  if (options.searching) return rows;
  const isShown = (id: string): boolean => SHOWN.has(statuses?.get(id) ?? 'idle');
  return withAccordion(rows, isShown, options.expanded ?? new Set());
}
