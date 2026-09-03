import type { ProviderEnvVar } from '@claude-control/contracts';

export interface ProviderEnvFormProps {
  isOpen: boolean;
  onOpenChange: (open: boolean) => void;
  /** Имя CLI — для подсказки «изменения применятся после перезапуска …». */
  providerName: string;
  /** Правимая переменная (undefined → создание новой). */
  envVar?: ProviderEnvVar;
  /** Уже существующие ключи — чтобы не допустить дубликат при создании. */
  existingKeys: string[];
  onSubmit: (draft: ProviderEnvVar) => void;
  isPending: boolean;
}
