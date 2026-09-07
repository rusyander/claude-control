export interface BaselineViewerProps {
  isOpen: boolean;
  onOpenChange: (isOpen: boolean) => void;
  projectPath: string | undefined;
  /** Кейс, чьи точки сверяются. Пусто — окно ничего не запрашивает. */
  caseId: string | undefined;
  /** Заголовок кейса для шапки окна: id человеку ничего не говорит. */
  caseTitle?: string;
}
