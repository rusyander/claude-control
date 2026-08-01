import type { ProviderEnvVar } from '@agentdeck/contracts';

export interface ProviderEnvFormProps {
  isOpen: boolean;
  onOpenChange: (open: boolean) => void;
  /** Правимая переменная (undefined → создание новой). */
  envVar?: ProviderEnvVar;
  /** Уже существующие ключи — чтобы не допустить дубликат при создании. */
  existingKeys: string[];
  onSubmit: (draft: ProviderEnvVar) => void;
  isPending: boolean;
}
