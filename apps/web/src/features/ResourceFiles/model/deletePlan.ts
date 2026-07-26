import { countFiles, type TreeNode } from './buildTree';

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

/**
 * Попадает ли открытый файл под удаление. Проверяем не только сам путь, но и
 * вложенность: удалили папку — открытый внутри неё файл тоже исчез, и держать
 * его в редакторе нельзя, иначе правка уйдёт в несуществующий путь.
 */
export function isRemovedByDelete(selected: string | undefined, deletedPath: string): boolean {
  if (!selected) return false;
  return selected === deletedPath || selected.startsWith(`${deletedPath}/`);
}
