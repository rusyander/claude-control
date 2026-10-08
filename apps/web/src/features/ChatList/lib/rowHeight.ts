import type { Row } from '../ui/ChatList/ChatList.types';
import { ROW_HEIGHT, MORE_HEIGHT, GROUP_HEIGHT } from '../ui/ChatList/ChatList.constants';

/** Высота строки виртуального списка по её виду — ровно та, что нарисована. */
export function rowHeight(row: Row): number {
  if (row.kind === 'chat') return ROW_HEIGHT;
  if (row.kind === 'more') return MORE_HEIGHT;
  return GROUP_HEIGHT;
}
