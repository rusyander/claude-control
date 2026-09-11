import type { EnvTransferPromptsPlan } from './EnvTransfer.types';

export interface EnvTransferPromptsProps {
  plan: EnvTransferPromptsPlan;
  /** Отмеченные идентификаторы промптов. */
  selected: Set<string>;
  onToggle: (id: string) => void;
}
