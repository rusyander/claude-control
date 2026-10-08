import type { ChatRowData } from '../ui/ChatList/ChatList.types';

/** Заглушка удалённого корня: дата — самого свежего ребёнка, своего у неё нет. */
export function lostParentRow(orphan: ChatRowData): ChatRowData {
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
