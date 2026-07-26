import type { ResourceKind } from '@entities/Resource';
import type { TreeNode } from '../model/buildTree';
import type { CreateTarget } from '../model/createTarget';

export interface ResourceFileTreeProps {
  kind: ResourceKind;
  id: string;
}

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

export interface NewNodeInputProps {
  placeholder: string;
  onSubmit: (name: string) => void;
  onCancel: () => void;
}
