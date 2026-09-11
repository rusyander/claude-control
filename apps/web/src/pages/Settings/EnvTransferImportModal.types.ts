import type { EnvTransferPlan } from './EnvTransfer.types';

/** Что именно человек отметил к развороту: файлы, контуры, промпты, шлюз. */
export interface EnvTransferApplyChoice {
  selection: string[];
  platforms: string[];
  /** Идентификаторы промптов, чьи правки человек согласился принять. */
  prompts: string[];
  gateway: boolean;
}

export interface EnvTransferImportModalProps {
  plan?: EnvTransferPlan;
  isBusy: boolean;
  onApply: (choice: EnvTransferApplyChoice) => void;
  onClose: () => void;
}
