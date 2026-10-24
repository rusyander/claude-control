import type { ChatTreeView } from '@agentdeck/contracts/chat-handoff';
import type { GroupEvent, GroupSnapshot } from './groupEvents.types';

/** Ключ группы: дерево (корень) и номер группы в плане разделения. */
const keyOf = (root: string, index: number): string => `${root}#${index}`;

/** Снимок статусов групп одного дерева. */
export function snapshotGroups(tree: ChatTreeView): GroupSnapshot {
  return new Map(
    (tree.split?.groups ?? []).map((group) => [keyOf(tree.root, group.index), group.status]),
  );
}

/**
 * Что случилось с группами дерева между двумя снимками — то, о чём Деке стоит
 * сказать: `failed` — группа упала, `paused` — остановлена, `done` — доставлена.
 * Первый снимок дерева событий не даёт: открыть хаб с давно упавшей группой —
 * не новость. Новая группа (её не было в прошлом снимке) — тоже: её статус
 * видят впервые, а не заметили перемену.
 */
export function diffGroups(previous: GroupSnapshot | undefined, tree: ChatTreeView): GroupEvent[] {
  if (!previous) return [];
  const events: GroupEvent[] = [];
  for (const group of tree.split?.groups ?? []) {
    const before = previous.get(keyOf(tree.root, group.index));
    if (before === undefined || before === group.status) continue;
    const base = { root: tree.root, index: group.index, title: group.title };
    if (group.status === 'failed') events.push({ kind: 'groupFailed', ...base });
    else if (group.status === 'paused') events.push({ kind: 'groupStopped', ...base });
    else if (group.status === 'done') events.push({ kind: 'groupDelivered', ...base });
  }
  return events;
}
