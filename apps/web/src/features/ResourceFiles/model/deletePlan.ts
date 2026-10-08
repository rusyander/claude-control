import type { TreeNode } from './buildTree.types';
import { countFiles } from './countFiles';

/**
 * Что именно удаляем — основа текста подтверждения.
 *
 * Удаление в дереве необратимо и у папки уносит всю вложенность разом, поэтому
 * перед диалогом нужно знать не только путь, но и цену клика — сколько файлов
 * исчезнет.
 */
export interface DeletePlan {
  path: string;
  /** Имя узла — его же просят набрать в подтверждении. */
  name: string;
  isDirectory: boolean;
  /** Сколько файлов исчезнет: у папки — считая вложенные. */
  fileCount: number;
}

export function planDelete(node: TreeNode): DeletePlan {
  return {
    path: node.path,
    name: node.name,
    isDirectory: node.isDirectory,
    fileCount: countFiles(node),
  };
}
