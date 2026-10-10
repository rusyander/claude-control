import { accessSync, constants, statSync } from 'node:fs';
import { posix } from 'node:path';
import process from 'node:process';

/**
 * Поиск команды в PATH на macOS и Linux — без внешнего `which`.
 *
 * `which` есть не везде: в базовой установке Arch и в образах Fedora его нет, и
 * поиск через него отвечал «не найдено» на любую команду — панель решала, что
 * не стоит ни Claude Code, ни один другой CLI. Здесь каталоги PATH обходятся
 * напрямую, как это делает сама оболочка: обычный файл с правом на исполнение.
 * На Windows поиск остаётся у `where` — у него PATHEXT и `.cmd`-обёртки.
 *
 * Файл без типов: его читает и `tools/doctor.mjs` голым Node.
 */

/** Обычный файл (по ссылке — её цель) с правом на исполнение. */
function isExecutableFile(path) {
  try {
    if (!statSync(path).isFile()) return false;
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Все копии команды в PATH по порядку поиска (как `which -a`). Имя с `/` —
 * путь, PATH не нужен. Пустые элементы PATH пропускаются: «текущий каталог»
 * зависел бы от того, откуда запущен сервер.
 */
export function posixPathMatches(
  command,
  pathVar = process.env.PATH ?? '',
  isExecutable = isExecutableFile,
) {
  if (!command) return [];
  if (command.includes('/')) return isExecutable(command) ? [command] : [];
  const found = [];
  for (const dir of pathVar.split(':')) {
    if (!dir) continue;
    const candidate = posix.join(dir, command);
    if (!found.includes(candidate) && isExecutable(candidate)) found.push(candidate);
  }
  return found;
}
