import type { EnvTransferExportResult, EnvTransferPreview } from './EnvTransfer.types';

export interface EnvTransferExportModalProps {
  /** Показывается до сборки: что уедет и чего в архиве не будет. */
  preview?: EnvTransferPreview;
  /** Показывается после сборки: путь к готовому архиву. */
  result?: EnvTransferExportResult;
  isBusy: boolean;
  onChooseFolder: () => void;
  onClose: () => void;
}
