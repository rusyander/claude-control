import type { ListGroup } from '../ui/ChatList/ChatList.types';

/** Подпись заголовка: «Закреплённые», «Сейчас работают» или дата. */
export function groupLabel(group: ListGroup): string {
  if (group === 'pinned') return 'chat.pinnedGroup';
  if (group === 'running') return 'chat.runningNow';
  return `chat.${group}`;
}
