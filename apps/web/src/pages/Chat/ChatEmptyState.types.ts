export interface ChatEmptyStateProps {
  /** Разговор заводится в каталоге проекта — подсказки тогда другие. */
  isProjectContext: boolean;
  projectName?: string;
  projectPath?: string;
  onOpenEditor: (path: string) => void;
  /** Щелчок по подсказке подставляет её текст в поле ввода. */
  onPick: (prompt: string) => void;
}
