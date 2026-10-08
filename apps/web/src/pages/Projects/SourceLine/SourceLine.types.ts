export interface SourceLineProps {
  /** `true` — файл правится на этой вкладке; `false` — панель только показывает. */
  isEditable: boolean;
  /** Файл или каталог, из которого вкладка читает — абсолютным путём. */
  path: string;
}
