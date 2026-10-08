export interface ProjectCodeModalProps {
  isOpen: boolean;
  onOpenChange: (open: boolean) => void;
  /** Каталог проекта: он же корень дерева и граница записи. */
  projectPath: string;
  /**
   * Разговор, чьи правки показываются диффом. Без него файлы открываются как
   * обычно, просто без сравнения — новый чат ещё ничего не менял.
   */
  chatId?: string;
}
