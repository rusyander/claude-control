export interface TestDraftModalProps {
  isOpen: boolean;
  onOpenChange: (isOpen: boolean) => void;
  /** Каталог проверяемого проекта — им адресуются все запросы раздела. */
  projectPath?: string;
  /** Прогон-автор черновика: он же имя файла. */
  runId?: string;
}
