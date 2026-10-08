/**
 * `YYYY-MM-DD` → полночь ЭТИХ суток в местном поясе.
 *
 * Через конструктор с числами, а не через разбор строки: `new Date('2026-08-30')`
 * трактуется как UTC и в поясе +3 указывает на 29 августа.
 */
export function parseLocalDay(value?: string): Date | undefined {
  if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return undefined;
  const [year = 0, month = 1, day = 1] = value.split('-').map(Number);
  const date = new Date(year, month - 1, day);
  return Number.isNaN(date.getTime()) ? undefined : date;
}
