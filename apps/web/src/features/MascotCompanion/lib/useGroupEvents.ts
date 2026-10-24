import { useEffect, useRef } from 'react';
import { useQueryClient, type Query } from '@tanstack/react-query';
import type { ChatTreeView } from '@agentdeck/contracts/chat-handoff';
import { diffGroups, snapshotGroups } from '../model/groupEvents';
import type { GroupEvent, GroupSnapshot } from '../model/groupEvents.types';

/** Дерево разговоров с планом разделения — не соседний ответ под тем же ключом. */
function asTree(data: unknown): ChatTreeView | undefined {
  if (!data || typeof data !== 'object') return undefined;
  const tree = data as Partial<ChatTreeView>;
  return typeof tree.root === 'string' && Array.isArray(tree.split?.groups)
    ? (tree as ChatTreeView)
    : undefined;
}

/**
 * Перемены статусов групп разделения — из тех деревьев, что панель и так
 * читает (`['chat-tree', id]`: хаб родителя, чат группы). Своего опроса нет:
 * лишний запрос к серверу ради реплики маскота того не стоит. Поэтому о
 * группе Дека узнаёт, пока её дерево на экране или в кэше обновляется.
 * Снимок — на корень дерева: одно дерево под ключами разных разговоров
 * перемену даёт один раз.
 */
export function useGroupEvents(onEvents: (events: GroupEvent[]) => void): void {
  const queryClient = useQueryClient();
  const callback = useRef(onEvents);
  callback.current = onEvents;

  useEffect(() => {
    const cache = queryClient.getQueryCache();
    const snapshots = new Map<string, GroupSnapshot>();
    const look = (query: Query): void => {
      if (query.queryKey[0] !== 'chat-tree') return;
      const tree = asTree(query.state.data);
      if (!tree) return;
      const events = diffGroups(snapshots.get(tree.root), tree);
      snapshots.set(tree.root, snapshotGroups(tree));
      if (events.length > 0) callback.current(events);
    };
    cache.getAll().forEach(look);
    return cache.subscribe((event) => {
      if (event.type === 'updated' && event.action.type === 'success') look(event.query);
      if (event.type === 'added') look(event.query);
    });
  }, [queryClient]);
}
