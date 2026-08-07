export interface ProjectCodeEditorProps {
  /** Путь от корня проекта: по нему выбирается грамматика подсветки. */
  path: string;
  /** Текущее содержимое файла — оно и правится. */
  content: string;
  /** Текст до правок агента; не задан — сравнивать не с чем. */
  baseline?: string;
  /** Время записи на диске: смена = файл переписали, состояние пересобирается. */
  mtimeMs: number;
  isEditable: boolean;
  showDiff: boolean;
  onChange: (value: string) => void;
  onSave: () => void;
}
