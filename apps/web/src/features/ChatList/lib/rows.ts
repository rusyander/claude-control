import type { ChatSummary } from '@agentdeck/contracts';
import { isLive, type RunStatus } from '@shared/lib/agent-runs';
import type { ChatRowData, ListGroup, Row, TimeGroup } from '../ui/ChatList.types';

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
 * Снятые перезапуском разделения дети (`retired`) уходят в конец своей ветви,
 * под разделитель «Неактивно» (находка 20 журнала): работа их не продолжается,
 * а вперемешку с живыми группами они читались как ещё идущие.
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

    const kin = byParent.get(item.chat.id) ?? [];
    const live = kin.filter((child) => !child.chat.retired);
    const retired = kin.filter((child) => child.chat.retired);
    for (const child of [...live, ...retired]) {
      if (placed.has(child.chat.id)) continue;
      const first = child === retired[0];
      rows.push({ ...child, depth: 1, ...(first ? { inactiveStart: true } : {}) });
      placed.add(child.chat.id);
    }
  }

  return rows;
}

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
 * Строки поднятых ветвей помечаются `pinned`: заголовок даты над ними врал бы —
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
    for (const row of [root, ...running, ...idle]) active.push({ ...row, pinned: true });
  }

  return active.length === 0 ? items : [...active, ...rest];
}

/** Раскладывает отсортированный список по группам «Сейчас работают / Сегодня / Вчера / …». */
export function withGroupHeaders(items: ChatRowData[]): Row[] {
  const rows: Row[] = [];
  let current: ListGroup | undefined;

  for (const data of items) {
    // Ветвь дерева не отрывается от своего корня: у ребёнка своя дата, и по ней
    // между ним и родителем мог бы встать заголовок «Вчера» — тогда дерево
    // распалось бы ровно там, ради чего его и рисуют.
    const own: ListGroup = data.pinned ? 'running' : timeGroup(data.chat.updatedAt);
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

/**
 * Строки списка целиком: дерево, поднятые ветви, заголовки. «Идёт» — живой
 * прогон, в том числе замолчавший, или разделение в работе (`inWork`: между
 * стадиями группы прогона нет, а работа идёт).
 */
export function chatListRows(
  found: ChatRowData[],
  statuses: ReadonlyMap<string, RunStatus> | undefined,
): Row[] {
  const working = new Set(found.filter((row) => row.chat.inWork).map((row) => row.chat.id));
  return withGroupHeaders(
    withActiveFirst(withTree(found), (id) => {
      const status = statuses?.get(id);
      return working.has(id) || (status !== undefined && isLive(status));
    }),
  );
}

/** Ключ строки виртуального списка: у заголовка — группа, у разделителя — ветвь. */
export function rowKey(row: Row): string {
  if (row.kind === 'header') return `group-${row.group}`;
  if (row.kind === 'inactive') return `inactive-${row.parentId}`;
  return row.data.chat.id;
}
