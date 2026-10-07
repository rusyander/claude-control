import type { ChatSummary } from '@agentdeck/contracts';
import { isLive, type RunStatus } from '@shared/lib/agent-runs';
import type {
  ChatListRowsOptions,
  ChatRowData,
  ListGroup,
  Row,
  TimeGroup,
} from '../ui/ChatList.types';

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
 * Сирота, чей родитель отфильтрован поиском, остаётся обычной строкой на своём
 * месте: спрятать разговор, потому что не нашлась его родня, — худшее, что
 * можно сделать со списком. Родителя же, которого нет на диске вовсе (`known`
 * его не знает: Claude Code стёр транскрипт по `cleanupPeriodDays`, а дети
 * живы), заменяет заглушка `lostParent` — иначе двадцать детей прошлого
 * разделения рассыпались по датам, и ветвь «пропадала» (владелец, 07.10.2026).
 */
export function withTree(items: ChatRowData[], known?: ReadonlySet<string>): ChatRowData[] {
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
  const lost = (parent: string | undefined): parent is string =>
    parent !== undefined && known !== undefined && !known.has(parent);
  const placed = new Set<string>();
  const rows: ChatRowData[] = [];

  for (const item of items) {
    // Ребёнка, у которого родитель тоже в списке, ставит сам родитель.
    if (item.chat.parentId && present.has(item.chat.parentId)) continue;
    if (placed.has(item.chat.id)) continue;

    // Первый (самый свежий) сирота удалённого родителя ставит на своё место
    // заглушку, под неё — всех братьев.
    const root = lost(item.chat.parentId) ? lostParentRow(item) : item;
    rows.push(root);
    placed.add(root.chat.id);

    const kin = byParent.get(root.chat.id) ?? [];
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

/** Заглушка удалённого корня: дата — самого свежего ребёнка, своего у неё нет. */
function lostParentRow(orphan: ChatRowData): ChatRowData {
  const { chat } = orphan;
  return {
    chat: {
      id: chat.parentId ?? '',
      title: '',
      project: chat.project,
      projectPath: chat.projectPath,
      isSandbox: false,
      messageCount: 0,
      createdAt: chat.createdAt,
      updatedAt: chat.updatedAt,
    },
    lostParent: true,
  };
}

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

/** Раскладывает отсортированный список по группам «Сейчас работают / Сегодня / Вчера / …». */
export function withGroupHeaders(items: ChatRowData[]): Row[] {
  const rows: Row[] = [];
  let current: ListGroup | undefined;

  for (const data of items) {
    // Ветвь дерева не отрывается от своего корня: у ребёнка своя дата, и по ней
    // между ним и родителем мог бы встать заголовок «Вчера» — тогда дерево
    // распалось бы ровно там, ради чего его и рисуют.
    const own = ownGroup(data);
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

/** Группа строки без оглядки на ветвь: закреплённые, идущие, иначе дата. */
function ownGroup(data: ChatRowData): ListGroup {
  if (data.pinnedRow) return 'pinned';
  if (data.raised) return 'running';
  return timeGroup(data.chat.updatedAt);
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

/** Дети с этими статусами стоят над гармошкой: идёт, ждёт человека, ошибка. */
const SHOWN: ReadonlySet<RunStatus> = new Set<RunStatus>(['running', 'waiting', 'error']);

/** Строка, которая принадлежит ветви над ней: ребёнок или разделитель «Неактивно». */
function isBranchTail(row: Row): boolean {
  return row.kind === 'inactive' || (row.kind === 'chat' && Boolean(row.data.depth));
}

/**
 * Строки списка целиком: дерево, поднятые ветви, заголовки, гармошки ветвей.
 * «Идёт» — живой прогон, в том числе замолчавший, или разделение в работе
 * (`inWork`: между стадиями группы прогона нет, а работа идёт).
 *
 * Пока идёт поиск, гармошек нет: найденный разговор обязан быть виден, даже
 * если его ветвь свёрнута, — иначе поиск «ничего не нашёл» при счётчике 1.
 */
export function chatListRows(
  found: ChatRowData[],
  statuses: ReadonlyMap<string, RunStatus> | undefined,
  options: ChatListRowsOptions = {},
): Row[] {
  const working = new Set(found.filter((row) => row.chat.inWork).map((row) => row.chat.id));
  const isActive = (id: string): boolean => {
    const status = statuses?.get(id);
    return working.has(id) || (status !== undefined && isLive(status));
  };
  // Заглушки удалённых родителей — только вне поиска: в поиске сирота стоит
  // там, где его нашли.
  const tree = withTree(found, options.searching ? undefined : options.known);
  const { pinned, rest } = withPinnedFirst(tree);
  const rows = withGroupHeaders([...pinned, ...withActiveFirst(rest, isActive)]);
  if (options.searching) return rows;
  const isShown = (id: string): boolean => SHOWN.has(statuses?.get(id) ?? 'idle');
  return withAccordion(rows, isShown, options.expanded ?? new Set());
}

/** Ключ строки виртуального списка: у заголовка — группа, у разделителя и гармошки — ветвь. */
export function rowKey(row: Row): string {
  if (row.kind === 'header') return `group-${row.group}`;
  if (row.kind === 'inactive') return `inactive-${row.parentId}`;
  if (row.kind === 'more') return `more-${row.parentId}`;
  return row.data.chat.id;
}
