import type { Row } from '../ui/ChatList/ChatList.types';

/** Ключ строки виртуального списка: у заголовка — группа, у разделителя и гармошки — ветвь. */
export function rowKey(row: Row): string {
  if (row.kind === 'header') return `group-${row.group}`;
  if (row.kind === 'inactive') return `inactive-${row.parentId}`;
  if (row.kind === 'more') return `more-${row.parentId}`;
  return row.data.chat.id;
}
