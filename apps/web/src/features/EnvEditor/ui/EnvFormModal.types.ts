import type { EnvVar } from '@agentdeck/contracts';

export interface EnvFormModalProps {
  isOpen: boolean;
  onOpenChange: (isOpen: boolean) => void;
  /** Пусто — создание новой переменной, иначе правка существующей. */
  envVar?: EnvVar;
}
