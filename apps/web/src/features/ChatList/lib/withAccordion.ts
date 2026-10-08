import type { Row } from '../ui/ChatList/ChatList.types';

/** Строка, которая принадлежит ветви над ней: ребёнок или разделитель «Неактивно». */
export function isBranchTail(row: Row): boolean {
  return row.kind === 'inactive' || (row.kind === 'chat' && Boolean(row.data.depth));
}

/**
 * Гармошка ветви (G1, владелец 05.10.2026): под родителем видны только дети, у
 * которых что-то происходит прямо сейчас, все остальные — одной строкой «Ещё N».
 *
 * Зачем: у разделения на десять групп работают две-три, а ветвь занимала
 * экран целиком, и за ней не было видно остальных разговоров. Идущие дети
 * остаются на виду — за ними следят; стоящие и снятые перезапуском прячутся
 * под одну строку на ветвь. Ветвь без идущих детей прячет всех.
 *
 * «На виду» (`isShown`) уже, чем «ветвь в работе»: зелёная точка (идёт), жёлтая
 * (ждёт человека) и красная (ошибка). Серая (прогон молчит дольше STALL_MS),
 * стадия разделения без прогона и стоящие уходят под гармошку — владелец 07.10:
 * такие дети висели над «Ещё N» под работающим родителем. Статусы приходят живыми,
 * поэтому ребёнок уходит под гармошку и возвращается сам, без перезагрузки.
 *
 * Работает поверх заголовков: ветвь — строка корня и идущие за ней строки
 * детей и разделитель «Неактивно». Порядок свёрнутых сохраняется, поэтому в
 * раскрытой гармошке снятые дети по-прежнему стоят под «Неактивно», в самом
 * низу ветви. Раскрыта ли ветвь, решает вызывающий (`expanded` — id родителей).
 */
export function withAccordion(
  rows: Row[],
  isShown: (chatId: string) => boolean,
  expanded: ReadonlySet<string>,
): Row[] {
  const out: Row[] = [];
  let at = 0;
  while (at < rows.length) {
    const root = rows[at] as Row;
    out.push(root);
    at += 1;
    if (root.kind !== 'chat' || root.data.depth) continue;

    const tail: Row[] = [];
    for (let next = rows[at]; next && isBranchTail(next); next = rows[at]) {
      tail.push(next);
      at += 1;
    }
    const shown = tail.filter(
      (row) => row.kind === 'chat' && !row.data.chat.retired && isShown(row.data.chat.id),
    );
    const folded = tail.filter((row) => !shown.includes(row));
    const count = folded.filter((row) => row.kind === 'chat').length;
    out.push(...shown);
    if (count === 0) continue;

    const parentId = root.data.chat.id;
    const open = expanded.has(parentId);
    out.push({ kind: 'more', group: root.group, parentId, count, expanded: open });
    if (open) out.push(...folded);
  }
  return out;
}
