import type { ChatSummary } from '@claude-control/contracts';
import type { ChatRowData, Row, TimeGroup } from '../ui/ChatList.types';

/**
 * Совпадения по телу приходят глобально; показываем из них только те, что есть
 * в видимом списке (он уже ограничен вкладкой), и переносим на строки сниппет с
 * числом совпадений. Порядок — от свежего к старому, как и в обычном списке.
 */
export function matchBodyHits(
  chats: ChatSummary[],
  hits: { sessionId: string; snippet: string; matchCount: number }[] | undefined,
): ChatRowData[] {
  if (!hits || hits.length === 0) return [];

  const bySession = new Map(hits.map((hit) => [hit.sessionId, hit]));

  return chats
    .filter((chat) => bySession.has(chat.id))
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    .map((chat) => {
      const hit = bySession.get(chat.id);
      return { chat, snippet: hit?.snippet, matchCount: hit?.matchCount };
    });
}

/**
 * Ставит чаты, выделенные разделением, под их родителя.
 *
 * Дерево нужно ровно для одного: увидеть, что пять чатов приехали из одной
 * просьбы. Поэтому оно ровно одноуровневое и строится поверх УЖЕ отсортированного
 * списка — порядок родителей остаётся прежним (свежие сверху), а дети встают под
 * своим родителем в том же порядке, в каком их завели.
 *
 * Сирота (родитель не попал в видимый список — удалён, отфильтрован поиском)
 * остаётся обычной строкой на своём месте: спрятать разговор, потому что не
 * нашлась его родня, — худшее, что можно сделать со списком.
 */
export function withTree(items: ChatRowData[]): ChatRowData[] {
  const byParent = new Map<string, ChatRowData[]>();
  for (const item of items) {
    const parent = item.chat.parentId;
    if (!parent) continue;
    const kin = byParent.get(parent);
    if (kin) kin.push(item);
    else byParent.set(parent, [item]);
  }
  if (byParent.size === 0) return items;

  const present = new Set(items.map((item) => item.chat.id));
  const placed = new Set<string>();
  const rows: ChatRowData[] = [];

  for (const item of items) {
    // Ребёнка, у которого родитель тоже в списке, ставит сам родитель.
    if (item.chat.parentId && present.has(item.chat.parentId)) continue;

    rows.push(item);
    placed.add(item.chat.id);

    for (const child of byParent.get(item.chat.id) ?? []) {
      if (placed.has(child.chat.id)) continue;
      rows.push({ ...child, depth: 1 });
      placed.add(child.chat.id);
    }
  }

  return rows;
}

/** Раскладывает отсортированный список по группам «Сегодня / Вчера / …». */
export function withGroupHeaders(items: ChatRowData[]): Row[] {
  const rows: Row[] = [];
  let current: TimeGroup | undefined;

  for (const data of items) {
    // Ветвь дерева не отрывается от своего корня: у ребёнка своя дата, и по ней
    // между ним и родителем мог бы встать заголовок «Вчера» — тогда дерево
    // распалось бы ровно там, ради чего его и рисуют.
    const group = data.depth
      ? (current ?? timeGroup(data.chat.updatedAt))
      : timeGroup(data.chat.updatedAt);
    if (group !== current) {
      rows.push({ kind: 'header', group });
      current = group;
    }
    rows.push({ kind: 'chat', group, data });
  }

  return rows;
}

export function timeGroup(iso: string): TimeGroup {
  const date = new Date(iso);
  const startOfToday = new Date();
  startOfToday.setHours(0, 0, 0, 0);

  if (date.getTime() >= startOfToday.getTime()) return 'today';

  const startOfYesterday = new Date(startOfToday);
  startOfYesterday.setDate(startOfYesterday.getDate() - 1);
  if (date.getTime() >= startOfYesterday.getTime()) return 'yesterday';

  const weekAgo = new Date(startOfToday);
  weekAgo.setDate(weekAgo.getDate() - 7);
  return date.getTime() >= weekAgo.getTime() ? 'thisWeek' : 'earlier';
}
