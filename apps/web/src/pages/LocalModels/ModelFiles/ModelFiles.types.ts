import type { CatalogRow, DownloadedFile } from '@entities/LocalModels';

export interface ModelFilesProps {
  row: CatalogRow;
  /** Удалить одно квантование — после подтверждения на странице. */
  onRemove: (file: DownloadedFile) => void;
}
