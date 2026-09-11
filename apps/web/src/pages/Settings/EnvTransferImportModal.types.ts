import type { EnvTransferPlan } from './EnvTransfer.types';

/** Что именно человек отметил к развороту: файлы, контуры, настройка шлюза. */
export interface EnvTransferApplyChoice {
  selection: string[];
  platforms: string[];
  gateway: boolean;
}

export interface EnvTransferImportModalProps {
  plan?: EnvTransferPlan;
  isBusy: boolean;
  onApply: (choice: EnvTransferApplyChoice) => void;
  onClose: () => void;
}
