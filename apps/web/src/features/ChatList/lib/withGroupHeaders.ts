import type { ChatRowData, ListGroup, Row } from '../ui/ChatList/ChatList.types';
import { timeGroup } from './timeGroup';

/** Группа строки без оглядки на ветвь: закреплённые, идущие, иначе дата. */
export function ownGroup(data: ChatRowData): ListGroup {
  if (data.pinnedRow) return 'pinned';
  if (data.raised) return 'running';
  return timeGroup(data.chat.updatedAt);
}

/** Раскладывает отсортированный список по группам «Сейчас работают / Сегодня / Вчера / …». */
export function withGroupHeaders(items: ChatRowData[]): Row[] {
  const rows: Row[] = [];
  let current: ListGroup | undefined;

  for (const data of items) {
    // Ветвь дерева не отрывается от своего корня: у ребёнка своя дата, и по ней
    // между ним и родителем мог бы встать заголовок «Вчера» — тогда дерево
    // распалось бы ровно там, ради чего его и рисуют.
    const own = ownGroup(data);
    const group = data.depth ? (current ?? own) : own;
    if (group !== current) {
      rows.push({ kind: 'header', group });
      current = group;
    }
    if (data.inactiveStart && data.chat.parentId) {
      rows.push({ kind: 'inactive', group, parentId: data.chat.parentId });
    }
    rows.push({ kind: 'chat', group, data });
  }

  return rows;
}
