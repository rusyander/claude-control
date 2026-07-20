import type { ScriptFile } from '@entities/Script';

export interface ScriptFormModalProps {
  isOpen: boolean;
  onOpenChange: (isOpen: boolean) => void;
  /** Пусто — создание нового скрипта. */
  script?: ScriptFile;
}
