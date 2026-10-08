/**
 * Одна строка о том, ЧТО собирается сделать инструмент: команда, файл, адрес.
 * Полный вход остаётся под «Подробнее» — решение принимают по сути вызова, и
 * прятать её за JSON значило бы разрешать вслепую.
 */
export function toolSummary(input: unknown): string {
  if (!input || typeof input !== 'object') return '';
  const fields = input as { [key: string]: unknown };
  for (const name of ['command', 'file_path', 'notebook_path', 'url', 'path', 'pattern', 'query']) {
    const value = fields[name];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return '';
}
