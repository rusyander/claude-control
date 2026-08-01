import type { EnvTransferPlan } from './EnvTransfer.types';

export interface EnvTransferImportModalProps {
  plan?: EnvTransferPlan;
  isBusy: boolean;
  onApply: (selection: string[]) => void;
  onClose: () => void;
}
