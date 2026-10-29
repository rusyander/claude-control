/** Что профиль видит в репозитории (04:45-49): входы обнаружения, без чтения всего дерева. */

/** Как читать файл: текст нужен разбору (манифесты), хэша хватает там, где важен сам факт и отпечаток. */
export type RepoInputKind = 'text' | 'hash';

export interface RepoViewFile {
  path: string; // от корня, прямые слеши
  sha: string; // sha256 содержимого — часть отпечатка входов (04:102)
  bytes: number;
  text: string | null; // только для `text`; больше `maxTextBytes` — null, файл назван в `overCap`
}

export interface RepoView {
  files: RepoViewFile[];
  dirs: string[]; // пройденные каталоги (для маркеров вида `tests/`)
  /** Обход упёрся в `maxEntries` — профиль называет это, а не молчит. */
  truncated: boolean;
  overCap: string[];
}

/** Что считать входом и куда спускаться — решает профиль (verifier), платформа только читает. */
export interface RepoViewSpec {
  inputKind(path: string, name: string): RepoInputKind | null;
  enterDir(path: string, name: string, depth: number): boolean;
  maxDepth: number;
  maxEntries: number;
  maxTextBytes: number;
}

export interface RepoDirEntry {
  name: string;
  dir: boolean;
  file: boolean;
}

/** Ввод-вывод обхода — подменяется в тестах отказов (P44: тайм-аут, ENOENT, EPERM, мусор). */
export interface RepoViewIo {
  /** Есть ли корень: `false` — «прочитал — нет» (единственный законный `absent`). */
  rootExists(path: string): Promise<boolean>;
  readdir(path: string): Promise<RepoDirEntry[]>;
  readFile(path: string): Promise<Buffer>;
}
