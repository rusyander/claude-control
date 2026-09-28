/** Что уходит на импорт: содержимое выбранного файла либо путь внутри проекта. */
export type ImportSource = { content?: string; file?: string };

/**
 * Источник импорта — ровно тот, что выбрал человек.
 *
 * Выбранный файл и путь в поле — два разных источника, и один не подменяет
 * другой: раньше пустой выбранный файл считался «ничего не выбрано», и
 * импортировался файл по пути из поля — совсем не тот, что взяли с диска.
 * Пустой выбранный файл — отказ (`'empty'`), текст отказа рисует форма.
 */
export function importSource(
  picked: string | undefined,
  typedPath: string,
): ImportSource | 'empty' {
  if (picked === undefined) return { file: typedPath.trim() || undefined };
  if (!picked.trim()) return 'empty';
  return { content: picked };
}
