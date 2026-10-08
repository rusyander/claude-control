/**
 * Файлы из буфера обмена и из перетаскивания. Один разбор на все поля агента:
 * раньше чат принимал перетаскивание, но не вставку, а остальные поля — ничего,
 * и снимок экрана, вставленный Ctrl+V, молча превращался в пустоту.
 */

/** Часть `DataTransfer`, которую читаем: так разбор проверяется без браузера. */
export interface TransferLike {
  readonly types?: readonly string[];
  readonly files?: ArrayLike<File> | null;
  readonly items?: ArrayLike<{ kind: string; getAsFile: () => File | null }> | null;
}
