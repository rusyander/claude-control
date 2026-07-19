import type { Automation } from '@claude-control/contracts';

export interface AutomationFormModalProps {
  isOpen: boolean;
  onOpenChange: (isOpen: boolean) => void;
  /** Пусто — создание нового сценария, иначе правка существующего. */
  automation?: Automation;
}
