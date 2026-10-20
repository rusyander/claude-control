import { readFileSync, realpathSync, statSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
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

  const mainDir = inSpellingOf(copyDir, resolve(dirname(commonDir)));
  if (normalizeProjectPath(mainDir) === normalizeProjectPath(copyDir)) return {};
  return { mainDir, copyDir };
}

/**
 * git пишет в указатель копии настоящий путь, раскрыв ссылки (Linux 20.10: корень
 * `/work → /real/work` дал `gitdir: /real/work/…`; на macOS так раскрывается
 * `/tmp → /private/tmp`), а реестр проектов и панель знают проект по пути через
 * ссылку — основная копия не находила свой проект. Она возвращается в написании
 * копии: общий хвост настоящего и данного пути копии — одно место дерева, выше
 * меняется только префикс; итог сверяется с диском. Windows не трогаем: там
 * разница написаний — регистр и 8.3, их сравнение и так складывает.
 */
function inSpellingOf(copyDir: string, mainDir: string): string {
  if (process.platform === 'win32') return mainDir;
  try {
    const realCopy = realpathSync.native(copyDir);
    if (realCopy === copyDir) return mainDir;
    const given = copyDir.split(sep);
    const real = realCopy.split(sep);
    let tail = 0;
    while (
      tail < given.length - 1 &&
      tail < real.length - 1 &&
      given[given.length - 1 - tail] === real[real.length - 1 - tail]
    )
      tail += 1;
    const rel = relative(real.slice(0, real.length - tail).join(sep) || sep, mainDir);
    if (rel.startsWith('..') || isAbsolute(rel)) return mainDir;
    const candidate = join(given.slice(0, given.length - tail).join(sep) || sep, rel);
    return realpathSync.native(candidate) === realpathSync.native(mainDir) ? candidate : mainDir;
  } catch {
    return mainDir;
  }
}
