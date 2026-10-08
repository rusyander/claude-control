import type { ChatSummary } from '@agentdeck/contracts';
import { samePath } from '../../../shared/lib/samePath';

// Одно сравнение путей на весь фронт: здешняя копия опускала регистр у любого
// пути и сливала на Linux/macOS разные каталоги в один (F-180).
export { samePath };

/**
 * Каталог, по которому меню чата отбирает ПРОЕКТНЫЕ группы, — основная копия.
 * Ребёнок разделения работает в git-копии, и сравнение с её каталогом прятало
 * группы проекта, а унаследованная рисовалась «Нет в списке». Основную копию
 * сервер называет в `homeProjectPath` сводки; сводки этого чата ещё нет —
 * берём её у любого чата той же копии; не нашлось — каталог чата как есть.
 */
export function groupScopePath(
  chats: readonly Pick<ChatSummary, 'id' | 'projectPath' | 'homeProjectPath'>[] | undefined,
  keys: readonly (string | undefined)[],
  projectPath: string | undefined,
): string | undefined {
  if (!projectPath) return undefined;
  const own = chats?.find((chat) => keys.includes(chat.id));
  if (own?.homeProjectPath) return own.homeProjectPath;
  const sibling = chats?.find(
    (chat) => chat.homeProjectPath && chat.projectPath && samePath(chat.projectPath, projectPath),
  );
  return sibling?.homeProjectPath ?? projectPath;
}
