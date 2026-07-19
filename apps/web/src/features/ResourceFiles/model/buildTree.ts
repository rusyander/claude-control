/**
 * Дерево файлов скилла из плоского списка путей.
 *
 * Сервер отдаёт пути вида `references/structure.md`, а показывать их нужно
 * вложенно: у больших скиллов файлов десятки, и плоский список из них
 * читается плохо.
 */

export interface TreeNode {
  name: string;
  /** Полный путь от корня скилла — по нему запрашивается содержимое. */
  path: string;
  isDirectory: boolean;
  children: TreeNode[];
}

export function buildTree(paths: string[]): TreeNode[] {
  const root: TreeNode[] = [];

  for (const filePath of paths) {
    const parts = filePath.split('/').filter(Boolean);
    let level = root;

    parts.forEach((part, index) => {
      const isLast = index === parts.length - 1;
      const currentPath = parts.slice(0, index + 1).join('/');

      let node = level.find((item) => item.name === part && item.isDirectory !== isLast);
      if (!node) {
        node = { name: part, path: currentPath, isDirectory: !isLast, children: [] };
        level.push(node);
      }

      level = node.children;
    });
  }

  return sortTree(root);
}

/** Папки идут первыми, внутри каждой группы — по алфавиту. */
function sortTree(nodes: TreeNode[]): TreeNode[] {
  return nodes
    .map((node) => ({ ...node, children: sortTree(node.children) }))
    .sort((a, b) => {
      if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
}

/** Сколько файлов внутри узла — подпись у свёрнутой папки. */
export function countFiles(node: TreeNode): number {
  if (!node.isDirectory) return 1;
  return node.children.reduce((total, child) => total + countFiles(child), 0);
}
