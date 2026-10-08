import type { TreeNode } from '../../model/buildTree.types';
import type { CreateTarget } from '../../model/createTarget.types';

export interface TreeItemProps {
  node: TreeNode;
  selected?: string;
  creatingIn?: CreateTarget;
  isWritable: boolean;
  onSelect: (path: string) => void;
  /** undefined — закрыть поле; из-за узкого `string` отмена и не могла его закрыть. */
  onCreateIn: (folder: CreateTarget) => void;
  onCreateFile: (folder: string, name: string) => void;
  /** Узел целиком: для подтверждения нужно знать, папка это и сколько файлов внутри. */
  onDelete: (node: TreeNode) => void;
  defaultOpen?: boolean;
}
