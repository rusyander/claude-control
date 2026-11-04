import type { ChatTreeView } from '@agentdeck/contracts/chat-handoff';

/** Опрос дерева, где что-то идёт: прогоны в нём стартуют и гаснут без вкладки. */
export const TREE_REFETCH_MS = 5000;

/** Опрос дерева одного разговора без пауз, прогонов и детей. */
export const TREE_IDLE_REFETCH_MS = 30_000;

/**
 * Как часто спрашивать дерево. Хаб Claude спрашивает его у ЛЮБОГО открытого
 * разговора (итоговая проверка 25.09, D1); дерево одного разговора без пауз,
 * прогонов и детей спрашивается реже.
 */
export function treeRefetchMs(tree: ChatTreeView | undefined): number {
  if (!tree) return TREE_REFETCH_MS;
  const idle = !tree.paused && tree.running === 0 && tree.nodes.length === 0;
  return idle ? TREE_IDLE_REFETCH_MS : TREE_REFETCH_MS;
}
