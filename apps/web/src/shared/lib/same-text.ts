const lf = (text: string): string => text.replace(/\r\n/g, '\n');

/**
 * Равенство без учёта стиля переносов: textarea отдаёт LF, файл бывает CRLF.
 * Один компаратор на все редакторы файлов — иначе на Windows-проекте после
 * сохранения вечно висело «есть несохранённые правки».
 */
export function sameText(a: string, b: string): boolean {
  return lf(a) === lf(b);
}
