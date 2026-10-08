import { useQuery } from '@tanstack/react-query';
import type { ChatTreeView } from '@agentdeck/contracts/chat-handoff';
import { apiClient } from '@shared/api/client';
import { treeRefetchMs } from '../lib/treeRefetch';

/**
 * Дерево разговоров одной просьбы и его пауза — сторона клиента.
 *
 * Дерево считает СЕРВЕР: связи «родитель → потомок» живут у него, и он же
 * глушит автостарты в стоящем дереве, когда вкладки нет. Клиенту остаётся
 * спросить и нажать; корень сервер находит по любому разговору дерева сам.
 */

export const chatTreeKeys = {
  all: ['chat-tree'] as const,
  tree: (chatId: string) => ['chat-tree', chatId] as const,
};

export function useChatTree(chatId: string | undefined, enabled: boolean) {
  return useQuery({
    queryKey: chatTreeKeys.tree(chatId ?? ''),
    queryFn: async () => {
      const { data } = await apiClient.get<ChatTreeView>(
        `/chat/${encodeURIComponent(chatId ?? '')}/tree`,
      );
      return data;
    },
    enabled: Boolean(chatId) && enabled,
    refetchInterval: (query) => treeRefetchMs(query.state.data),
  });
}
