import type { SectionNode } from './caseFilter.types';

/** Дерево в плоский список — так его рисуют отступами, без рекурсии в разметке. */
export function flattenSections(nodes: SectionNode[]): SectionNode[] {
  return nodes.flatMap((node) => [node, ...flattenSections(node.children)]);
}
