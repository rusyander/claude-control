import type { ResourceKind } from '@entities/Resource';
import type { TreeNode } from '../model/buildTree';

export interface ResourceFileTreeProps {
  kind: ResourceKind;
  id: string;
}

export interface TreeItemProps {
  node: TreeNode;
  selected?: string;
  creatingIn?: string;
  isWritable: boolean;
  onSelect: (path: string) => void;
  onCreateIn: (folder: string) => void;
  onCreateFile: (folder: string, name: string) => void;
  onDelete: (path: string) => void;
  defaultOpen?: boolean;
}

export interface NewNodeInputProps {
  placeholder: string;
  onSubmit: (name: string) => void;
  onCancel: () => void;
}
