export interface TestHistoryModalProps {
  isOpen: boolean;
  onOpenChange: (isOpen: boolean) => void;
  /** Путь проекта: история читается из его git, а не из панели. */
  projectPath?: string;
  /** Группа — она же файл `.agent/tests/<id>.tests.json`, историю которого показываем. */
  groupId: string;
}
