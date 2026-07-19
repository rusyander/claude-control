import type { Rule } from '@agentdeck/contracts';

export interface RuleFormModalProps {
  isOpen: boolean;
  onOpenChange: (isOpen: boolean) => void;
  /** Пусто — создание нового правила, иначе редактирование существующего. */
  rule?: Rule;
}
