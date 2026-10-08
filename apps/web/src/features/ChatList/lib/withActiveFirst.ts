import type { ChatRowData } from '../ui/ChatList/ChatList.types';

/**
 * Поднимает наверх ветви, где сейчас идёт прогон (владелец, 24.09.2026).
 *
 * Работает поверх `withTree`: ветвь — это корень и его дети, и поднимается
 * она целиком, иначе ребёнок уехал бы от родителя. Идущей ветвь считается,
 * если идёт корень или любой ребёнок: у разделения обычно работают группы, а
 * родитель молчит. Внутри поднятой ветви идущие дети встают первыми. Остальное
 * — в прежнем порядке (свежие сверху), порядок среди поднятых — тоже прежний.
 *
 * «Идёт» решает вызывающий: живой прогон или разделение в работе (метка
 * `inWork` — между стадиями конвейера прогона нет, а группа работает). Снятые
 * перезапуском дети остаются в самом низу ветви, что бы про них ни думал
 * `isActive`.
 *
 * Строки поднятых ветвей помечаются `raised`: заголовок даты над ними врал бы —
 * вчерашний чат, который работает сейчас, стоял бы под «Сегодня».
 */
export function withActiveFirst(
  items: ChatRowData[],
  isActive: (chatId: string) => boolean,
): ChatRowData[] {
  const branches: ChatRowData[][] = [];
  for (const item of items) {
    const branch = branches.at(-1);
    if (item.depth && branch) branch.push(item);
    else branches.push([item]);
  }

  const active: ChatRowData[] = [];
  const rest: ChatRowData[] = [];
  for (const [root, ...children] of branches) {
    if (!root) continue;
    const running = children.filter((child) => !child.chat.retired && isActive(child.chat.id));
    if (!isActive(root.chat.id) && running.length === 0) {
      rest.push(root, ...children);
      continue;
    }
    const idle = children.filter((child) => !running.includes(child));
    for (const row of [root, ...running, ...idle]) active.push({ ...row, raised: true });
  }

  return active.length === 0 ? items : [...active, ...rest];
}
