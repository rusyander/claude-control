import type { ProjectFileChange } from '@claude-control/contracts';

export interface ProjectCodeTreeProps {
  projectPath: string;
  /** Открытый файл — путь от корня проекта. */
  selected?: string;
  /** Правки агента по путям: по ним у файла появляются счётчики строк. */
  changes: Map<string, ProjectFileChange>;
  /** Каталоги, внутри которых что-то изменилось, — на любой глубине. */
  changedDirs: Set<string>;
  /** Раскрытые каталоги: состояние дерева живёт снаружи и переживает окно. */
  openDirs: string[];
  onToggleDir: (path: string) => void;
  onSelect: (path: string) => void;
}

export interface ProjectCodeBranchProps extends ProjectCodeTreeProps {
  /** Каталог этой ветки; пусто — корень проекта. */
  dir: string;
  /** Глубина вложенности: от неё считается отступ. */
  depth: number;
}
