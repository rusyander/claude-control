export interface AttachedFile {
  name: string;
  sizeBytes: number;
  /** Содержимое в base64 — сервер положит файл в папку чата. */
  base64: string;
}

export interface ChatComposerProps {
  value: string;
  onChange: (value: string) => void;
  /**
   * Отправка. `false` (в том числе через промис) означает, что сообщение не
   * приняли, — вложения тогда остаются в поле: иначе отказ сервера заставлял бы
   * прикладывать файлы заново.
   */
  onSend: (files: AttachedFile[]) => void | boolean | Promise<void | boolean>;
  onStop: () => void;
  /**
   * Файлы, которые не приложились (сейчас — крупнее предела). Сказать о них
   * обязана страница: отказ идёт тем же путём, что и отказ по типу файла, —
   * одним сообщением, а не вторым механизмом рядом.
   */
  onRejectFiles?: (names: string[]) => void;
  isRunning: boolean;
}
