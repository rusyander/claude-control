/**
 * Список строк из тела запроса (имена инструментов Gemini, правила Qwen, Continue
 * и Cursor): массив непустых строк. Пробелы по краям срезаются, повторы
 * схлопываются (порядок первого вхождения сохраняется). Не массив или элемент не
 * строка → `undefined`: черновик целиком отклоняется, в файл не пишем.
 */
export function parseToolList(value: unknown): string[] | undefined {
  if (value === undefined) return [];
  if (!Array.isArray(value)) return undefined;
  const list: string[] = [];
  for (const item of value) {
    if (typeof item !== 'string') return undefined;
    const name = item.trim();
    if (!name) continue;
    if (!list.includes(name)) list.push(name);
  }
  return list;
}
