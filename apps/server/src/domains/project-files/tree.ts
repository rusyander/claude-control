import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { ProjectFileNode, ProjectFileTree } from '@claude-control/contracts';
import { IGNORED_DIRS, MAX_DIR_ENTRIES } from './constants.ts';
import { resolveProjectPath, toProjectRelative } from './paths.ts';

/**
 * Дерево проекта, по одному уровню за запрос.
 *
 * Целиком его читать нельзя: в настоящем репозитории это десятки тысяч файлов, и
 * один ответ на мегабайты никому не нужен — раскрывают обычно две-три папки.
 * Скрытые файлы при этом ВИДНЫ (`.env.example`, `.gitignore` правят так же, как
 * всё остальное); прячутся только каталоги из `IGNORED_DIRS`, содержимое
 * которых генерируется.
 */
export function listProjectDir(root: string, dir: string): ProjectFileTree {
  const target = dir ? resolveProjectPath(root, dir) : root;
  const entries: ProjectFileNode[] = [];
  let truncated = false;

  for (const entry of readdirSync(target, { withFileTypes: true })) {
    if (entries.length >= MAX_DIR_ENTRIES) {
      truncated = true;
      break;
    }

    // Ссылки не разворачиваем: по ним обзор ушёл бы за пределы проекта, а
    // запись — тем более (той же логики держится `walkSectionFiles`).
    if (entry.isSymbolicLink()) continue;

    const isDir = entry.isDirectory();
    if (isDir && IGNORED_DIRS.has(entry.name)) continue;
    if (!isDir && !entry.isFile()) continue;

    const full = join(target, entry.name);
    const path = toProjectRelative(root, full);

    entries.push({
      name: entry.name,
      path,
      isDir,
      sizeBytes: isDir ? undefined : sizeOf(full),
    });
  }

  // Каталоги первыми, дальше по алфавиту — как в любом файловом дереве.
  entries.sort((a, b) => Number(b.isDir) - Number(a.isDir) || a.name.localeCompare(b.name, 'ru'));

  return { dir: dir ? toProjectRelative(root, target) : '', entries, truncated };
}

function sizeOf(path: string): number {
  try {
    return statSync(path).size;
  } catch {
    return 0;
  }
}
