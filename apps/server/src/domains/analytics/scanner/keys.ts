/** Ключи группировки отчёта: проект и локальные сутки. */

/**
 * Один и тот же каталог попадает в транскрипты в разном написании: буква диска
 * то строчная, то заглавная, разделители разные. Для Windows это один путь,
 * поэтому приводим к общему виду — иначе проект задваивается в отчёте.
 */
export function normalizeProject(cwd: string): string {
  const unified = cwd.replace(/\\/g, '/').replace(/\/+$/, '');
  return process.platform === 'win32' ? unified.toLowerCase() : unified;
}

export function shortenProject(cwd: string): string {
  const parts = cwd.split(/[\\/]/).filter(Boolean);
  return parts.slice(-2).join('/') || cwd;
}

/**
 * Локальная дата записи в виде `YYYY-MM-DD`. День активности воспринимается по
 * локальным суткам пользователя, поэтому и группировка byDay — по локальному
 * времени, в один пояс с byHour (`getHours`).
 */
export function localDay(timestamp: string): string {
  const date = new Date(timestamp);
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}
