import type { ChatRowData } from '../ui/ChatList/ChatList.types';

/**
 * Поднимает наверх ветви, закреплённые человеком (владелец, 07.10.2026).
 *
 * Закрепляется корень, а ветвь едет за ним целиком — как и у `withActiveFirst`,
 * иначе ребёнок уехал бы от родителя. Свежезакреплённая — выше. Идущая ветвь
 * остаётся в «Закреплённых»: человек сам сказал, где её искать; точка статуса
 * у неё та же.
 */
export function withPinnedFirst(items: ChatRowData[]): {
  pinned: ChatRowData[];
  rest: ChatRowData[];
} {
  const pinnedBranches: ChatRowData[][] = [];
  const rest: ChatRowData[] = [];
  let current: ChatRowData[] | undefined;
  for (const item of items) {
    if (item.depth) {
      (current ?? rest).push(item);
      continue;
    }
    if (item.chat.pinnedAt && !item.lostParent) {
      current = [item];
      pinnedBranches.push(current);
    } else {
      current = undefined;
      rest.push(item);
    }
  }
  pinnedBranches.sort((a, b) =>
    (b[0]?.chat.pinnedAt ?? '').localeCompare(a[0]?.chat.pinnedAt ?? ''),
  );
  return { pinned: pinnedBranches.flat().map((row) => ({ ...row, pinnedRow: true })), rest };
}
