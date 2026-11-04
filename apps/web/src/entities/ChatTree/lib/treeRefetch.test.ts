import { describe, it, expect } from 'vitest';
import type { ChatTreeView } from '@agentdeck/contracts/chat-handoff';
import { TREE_IDLE_REFETCH_MS, TREE_REFETCH_MS, treeRefetchMs } from './treeRefetch';

/**
 * Итоговая проверка 25.09 (D1): дерево теперь спрашивается у любого открытого
 * разговора. Разговор без детей, пауз и прогонов опрашивается редко, остальные —
 * часто.
 */
const lone: ChatTreeView = { root: 'чат', running: 0, nodes: [] };

describe('опрос дерева', () => {
  it('одинокий разговор — редко', () => {
    expect(treeRefetchMs(lone)).toBe(TREE_IDLE_REFETCH_MS);
  });

  it('ответа ещё нет — часто: первый ответ решает, что дальше', () => {
    expect(treeRefetchMs(undefined)).toBe(TREE_REFETCH_MS);
  });

  it('пауза, прогон, дети — часто', () => {
    expect(treeRefetchMs({ ...lone, paused: { at: 'x', chats: 0, pending: 0 } })).toBe(
      TREE_REFETCH_MS,
    );
    expect(treeRefetchMs({ ...lone, running: 1 })).toBe(TREE_REFETCH_MS);
    const child = { chatId: 'ребёнок' } as unknown as ChatTreeView['nodes'][number];
    expect(treeRefetchMs({ ...lone, nodes: [child] })).toBe(TREE_REFETCH_MS);
  });
});
