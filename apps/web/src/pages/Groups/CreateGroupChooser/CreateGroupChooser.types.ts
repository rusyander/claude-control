export type CreateGroupKind = 'scenario' | 'bundle';

export interface CreateGroupChooserProps {
  isOpen: boolean;
  onOpenChange: (isOpen: boolean) => void;
  /** Выбран вид: страница закрывает выбор и открывает форму этого вида. */
  onPick: (kind: CreateGroupKind) => void;
}
