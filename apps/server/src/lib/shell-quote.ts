/**
 * Путь аргументом строки для `shell: true`. Windows (cmd) — двойные кавычки, когда в
 * значении пробел или знак cmd. POSIX (`/bin/sh -c`) — одинарные: в двойных sh всё равно
 * раскрывает `$`, обратные кавычки и `\`, а без кавычек — ещё `;`, `*`, `~`, и путь
 * `/home/u/a$b/.venv/bin/python` запускал бы другой файл.
 */
export function shellQuote(value: string, platform: NodeJS.Platform = process.platform): string {
  if (platform === 'win32') return /[\s"'&|<>^()]/.test(value) ? `"${value}"` : value;
  return /^[\w./:@%+,=-]+$/.test(value) ? value : `'${value.replace(/'/g, `'\\''`)}'`;
}
