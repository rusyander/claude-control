import type { AgentTreeNode } from '@entities/AgentTree';

/** Адрес узла в разметке: id субагента у CLI, без файла — id вызова `Agent`. */
export function nodeKey(node: AgentTreeNode): string {
  return node.agent.agentId ?? node.agent.id;
}

/** Что сделать по клавише на узле дерева. */
export type TreeKeyAction =
  { kind: 'focus'; node: AgentTreeNode } | { kind: 'toggle'; open: boolean } | { kind: 'open' };

/**
 * Клавиатура ARIA-дерева (WAI-ARIA APG, «Tree View»): ↑↓ — соседний видимый
 * узел без перехода по кругу; → у свёрнутого раскрывает, у раскрытого ведёт к
 * первому вложенному; ← у раскрытого сворачивает, иначе ведёт к родителю;
 * Home/End — первый и последний видимые; Enter и пробел открывают ход.
 * `undefined` — клавиша не дерева, её не перехватываем.
 */
export function treeKeyTarget(
  key: string,
  current: AgentTreeNode,
  visible: readonly AgentTreeNode[],
  collapsed: ReadonlySet<string>,
): TreeKeyAction | undefined {
  const at = visible.indexOf(current);
  const hasChildren = current.children.length > 0;
  const isOpen = hasChildren && !collapsed.has(current.agent.id);
  const to = (node: AgentTreeNode | undefined): TreeKeyAction | undefined =>
    node && node !== current ? { kind: 'focus', node } : undefined;
  switch (key) {
    case 'ArrowDown':
      return to(visible[at + 1]);
    case 'ArrowUp':
      return to(at > 0 ? visible[at - 1] : undefined);
    case 'Home':
      return to(visible[0]);
    case 'End':
      return to(visible.at(-1));
    case 'ArrowRight':
      if (!hasChildren) return undefined;
      return isOpen ? to(current.children[0]) : { kind: 'toggle', open: true };
    case 'ArrowLeft':
      if (isOpen) return { kind: 'toggle', open: false };
      return to(visible.find((node) => node.children.includes(current)));
    case 'Enter':
    case ' ':
      return { kind: 'open' };
    default:
      return undefined;
  }
}
