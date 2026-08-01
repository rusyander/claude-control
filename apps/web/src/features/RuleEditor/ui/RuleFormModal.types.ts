import type { Rule } from '@claude-control/contracts';

/** Способ заполнения: простой текст, конструктор из блоков или список сразу. */
export type Mode = 'simple' | 'builder' | 'bulk';

export interface RuleFormModalProps {
  isOpen: boolean;
  onOpenChange: (isOpen: boolean) => void;
  /** Пусто — создание нового правила, иначе редактирование существующего. */
  rule?: Rule;
}
