/** Формы разбора CI (04:48, 04:123). */

export interface CiCommand {
  file: string;
  argv: string[];
  /** Каталог команды от корня репозитория — всегда внутри него. */
  cwd: string;
  /** Исходный текст простой команды — им отброшенная команда называется в заметках. */
  text: string;
}

/** Команда CI, которая не стала проверкой, и почему — называется в заметках профиля. */
export interface CiDropped {
  file: string;
  command: string;
  why: string;
}

export interface CiScan {
  commands: CiCommand[];
  unparsed: { file: string; count: number }[];
  dropped: CiDropped[];
  files: string[];
}

export type CiKind = 'github' | 'gitlab' | 'circleci';
