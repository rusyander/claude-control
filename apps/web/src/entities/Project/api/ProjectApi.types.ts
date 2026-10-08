// --- Обзор файловой системы для выбора папки проекта ---

export interface DirEntry {
  name: string;
  path: string;
  /** Есть только у файлов — их показывают, лишь когда запрошены расширения. */
  isFile?: boolean;
}
