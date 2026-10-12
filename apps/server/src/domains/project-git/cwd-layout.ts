import { readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { normalizeProjectPath } from '../../lib/app-store/projects.ts';

function isDir(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

/**
 * Раскладка каталога: копия ли он и от какого оригинала.
 *
 * Пустой ответ значит «сверять не с чем» — не репозиторий, основная копия,
 * подмодуль, нечитаемая раскладка.
 */
export interface CwdLayout {
  mainDir?: string;
  copyDir?: string;
}

/**
 * Читается ФАЙЛАМИ, без запуска git, и это главное свойство функции.
 *
 * Раскладку спрашивают на КАЖДОМ сообщении человека, а `git rev-parse` — это
 * порождение процесса: на этой машине измерено 44–62 мс на посылку, одинаково
 * внутри репозитория и вне его. Столько стоило узнать то, что git сам же
 * записал в два маленьких файла: рабочая копия помечена `.git`-ФАЙЛОМ со
 * строкой `gitdir:`, а общий каталог назван в `commondir` рядом. Читаем их —
 * получается тот же ответ за несколько обращений к файловой системе.
 *
 * Отличать копию от подмодуля умеет тот же `commondir`: у подмодуля (его
 * `.git` — тоже файл, но ведёт в `.git/modules/…`) этого файла нет, и каталог
 * честно читается как «не копия».
 */
export function layoutForCwd(cwd: string): CwdLayout {
  let dir = resolve(cwd);
  for (;;) {
    const marker = join(dir, '.git');
    // Каталог `.git` — обычный репозиторий, он сам себе источник.
    if (isDir(marker)) return {};
    if (isFile(marker)) return fromGitFile(dir, marker);

    const up = dirname(dir);
    if (up === dir) return {};
    dir = up;
  }
}

function fromGitFile(copyDir: string, marker: string): CwdLayout {
  let gitDir: string;
  try {
    const pointer = /^gitdir:\s*(.+)$/m.exec(readFileSync(marker, 'utf8'));
    if (!pointer?.[1]) return {};
    gitDir = resolve(copyDir, pointer[1].trim());
  } catch {
    return {};
  }

  let commonDir: string;
  try {
    commonDir = resolve(gitDir, readFileSync(join(gitDir, 'commondir'), 'utf8').trim());
  } catch {
    return {};
  }

  const mainDir = resolve(dirname(commonDir));
  if (normalizeProjectPath(mainDir) === normalizeProjectPath(copyDir)) return {};
  return { mainDir, copyDir };
}
