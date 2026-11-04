import type { ChildStageGroup } from '../ui/ChildStages.types';

/**
 * React-ключ карточки хаба. У каждой строки хаба есть свой чат — им и ключ;
 * пустой `chatId` (страховка) заменяет имя группы, а не общая пустая строка:
 * `""` у двух карточек позволял React потерять или задвоить одну из них
 * (наблюдатель WR-9).
 */
export function hubCardKey(group: ChildStageGroup): string {
  return group.chatId || group.title;
}
