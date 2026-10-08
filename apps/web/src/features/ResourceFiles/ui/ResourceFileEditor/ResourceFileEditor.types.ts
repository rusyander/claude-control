import type { ResourceKind } from '@entities/Resource';

export interface ResourceFileEditorProps {
  kind: ResourceKind;
  id: string;
  file: string;
  /** У плагинов файлы чужие — показываем, но править не даём. */
  isWritable: boolean;
  onClose: () => void;
}
