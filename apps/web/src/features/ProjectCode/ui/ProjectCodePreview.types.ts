import type { ProjectFileContent } from '@claude-control/contracts';

export interface ProjectCodePreviewProps {
  /** Каталог проекта: нужен адресу, по которому браузер тянет байты файла. */
  projectPath: string;
  file: ProjectFileContent;
  /**
   * Текст, из которого собирается показ SVG и разметки. Приходит НЕ из файла, а
   * из редактора: превью открывают, чтобы увидеть результат своей правки, а не
   * то, что лежало на диске до неё.
   */
  text: string;
}
