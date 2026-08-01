/**
 * Списки правил/инструментов ↔ текст: одно имя в строке, пустые строки
 * игнорируются. Форма прав у Gemini, Qwen, Continue, Cursor и у таба проекта
 * устроена одинаково — правила панель не толкует и хранит как есть.
 */
export const listToText = (list: string[]): string => list.join('\n');

export function textToList(text: string): string[] {
  const list: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    const name = line.trim();
    if (name && !list.includes(name)) list.push(name);
  }
  return list;
}

/** Списки совпадают с точностью до порядка — по нему считается «есть правки». */
export const sameList = (a: string[], b: string[]): boolean =>
  a.length === b.length && a.every((item, index) => item === b[index]);
