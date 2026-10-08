import type { TreeNode } from './buildTree.types';

/** Сколько файлов внутри узла — подпись у свёрнутой папки. */
export function countFiles(node: TreeNode): number {
  if (!node.isDirectory) return 1;
  return node.children.reduce((total, child) => total + countFiles(child), 0);
}
