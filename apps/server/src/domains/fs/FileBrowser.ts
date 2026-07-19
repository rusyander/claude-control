import { readdirSync, existsSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';

/**
 * Обзор файловой системы для выбора папки проекта. Только каталоги и только на
 * чтение: панель ничего не создаёт и не удаляет, а лишь показывает дерево, чтобы
 * пользователь ткнул в нужную папку и открыл её как проект.
 *
 * Приложение локальное и работает от имени пользователя, поэтому доступ к его
 * же файловой системе — ожидаемое поведение; во внешнюю сеть тут ничего не идёт.
 */

export interface DirEntry {
  name: string;
  path: string;
}

export interface DirListing {
  path: string;
  /** Родительский каталог для перехода вверх; у корня диска его нет. */
  parent?: string;
  entries: DirEntry[];
}

/** Точки входа: домашняя папка и корни дисков (или `/`). */
export function listRoots(): DirEntry[] {
  const roots: DirEntry[] = [{ name: '~', path: homedir() }];

  if (process.platform === 'win32') {
    for (let code = 65; code <= 90; code += 1) {
      const drive = `${String.fromCharCode(code)}:\\`;
      if (existsSync(drive)) roots.push({ name: drive, path: drive });
    }
  } else {
    roots.push({ name: '/', path: '/' });
  }

  return roots;
}

/**
 * Подкаталоги указанной папки, по алфавиту. Скрытые (начинающиеся с точки) не
 * показываем — это шум вроде .git и .cache, а не проекты. Недоступные записи
 * пропускаем, чтобы одна закрытая папка не роняла весь список.
 */
export function listDirectory(path: string): DirListing {
  const entries: DirEntry[] = [];

  for (const entry of readdirSync(path, { withFileTypes: true })) {
    if (entry.name.startsWith('.')) continue;

    const full = join(path, entry.name);
    try {
      // Симлинки и мусор пропускаем: интересуют настоящие каталоги.
      if (!entry.isDirectory() && !statSync(full).isDirectory()) continue;
    } catch {
      continue;
    }
    entries.push({ name: entry.name, path: full });
  }

  entries.sort((a, b) => a.name.localeCompare(b.name));

  const parent = dirname(path);
  return { path, parent: parent !== path ? parent : undefined, entries };
}
