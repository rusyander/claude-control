import type { PermissionRule } from '@agentdeck/contracts';

export interface PermissionFormModalProps {
  isOpen: boolean;
  onOpenChange: (isOpen: boolean) => void;
  /** Пусто — создание нового правила, иначе правка существующего. */
  rule?: PermissionRule;
  /** Предзаполненный шаблон: приходит из списка системных действий. */
  initialPattern?: string;
}
