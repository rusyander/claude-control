import type { ChangedRow } from '../lib/changedRows';

export interface ProjectCodeTreeProps {
  projectPath: string;
  /** Открытый файл — путь от корня проекта. */
  selected?: string;
  /**
   * Изменённые файлы по путям — и правки агента, и рабочее дерево git. У правок
   * агента в дереве видны счётчики строк, у остальных — буква состояния git.
   */
  changes: Map<string, ChangedRow>;
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
