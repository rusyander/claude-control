import type { ProjectGitChange } from '@claude-control/contracts';
import { CHANGED_FILES_MAX, STATUS_BY_CODE } from './constants.ts';

/**
 * Разбор вывода git. Чистые функции над строками: их проверяют на собранных
 * руками ответах, без запуска настоящего репозитория.
 */

/**
 * Хвост записи после `count` полей, разделённых пробелом. Путь в porcelain v2
 * всегда идёт последним, поэтому его нельзя резать по пробелам: в имени файла
 * они законны. Отсчитываем ровно служебные поля и берём весь остаток.
 */
function tailAfter(line: string, count: number): string {
  let index = 0;
  for (let n = 0; n < count; n += 1) {
    const next = line.indexOf(' ', index);
    if (next < 0) return '';
    index = next + 1;
  }
  return line.slice(index);
}

/** Число из `# branch.ab +1 -2`; мусор превращается в undefined, а не в NaN. */
function countOf(token: string | undefined): number | undefined {
  if (!token) return undefined;
  const value = Number.parseInt(token.slice(1), 10);
  return Number.isFinite(value) ? Math.abs(value) : undefined;
}

/** Одна запись статуса → строка списка. Незнакомый тип записи → undefined. */
function parseChange(entry: string): ProjectGitChange | undefined {
  if (entry.startsWith('? ')) {
    return { path: tailAfter(entry, 1), status: 'untracked', staged: false };
  }
  if (entry.startsWith('u ')) {
    return { path: tailAfter(entry, 10), status: 'conflict', staged: false };
  }
  const renamed = entry.startsWith('2 ');
  if (!renamed && !entry.startsWith('1 ')) return undefined;

  const xy = entry.slice(2, 4);
  // X — что уже в индексе, Y — что только в рабочем дереве. Показываем то из
  // двух, что случилось: индекс важнее, ведь именно он уйдёт в коммит.
  const staged = xy[0] !== '.' && xy[0] !== undefined;
  const code = staged ? xy[0] : xy[1];
  return {
    path: tailAfter(entry, renamed ? 9 : 8),
    status: (code && STATUS_BY_CODE[code]) || 'modified',
    staged,
  };
}

/**
 * Разбор `git status --porcelain=v2 --branch -z`. Один вызов отвечает сразу на
 * всё: какая ветка, отцеплен ли HEAD, насколько разошлась с upstream, сколько
 * файлов изменено и какие именно. Заголовок `# branch.oid (initial)` отличает
 * репозиторий без коммитов.
 *
 * Формат ИМЕННО `-z`: без него git экранирует пути с пробелами и не-латиницей
 * в C-кавычки с восьмеричными байтами, и любое русское имя файла приезжает
 * нечитаемым. Записи разделены NUL, а у переименования (`2 …`) прежний путь —
 * это СЛЕДУЮЩЕЕ поле, а не часть той же записи.
 */
export function parseStatus(stdout: string): {
  branch?: string;
  detached: boolean;
  unborn: boolean;
  dirtyCount: number;
  changedFiles: ProjectGitChange[];
  changedFilesTruncated: boolean;
  ahead?: number;
  behind?: number;
} {
  let branch: string | undefined;
  let detached = false;
  let unborn = false;
  let dirtyCount = 0;
  let ahead: number | undefined;
  let behind: number | undefined;
  const changedFiles: ProjectGitChange[] = [];

  const entries = stdout.split('\0');
  for (let index = 0; index < entries.length; index += 1) {
    const line = entries[index];
    if (!line) continue;
    if (line.startsWith('# branch.oid ')) {
      unborn = line.slice('# branch.oid '.length).trim() === '(initial)';
      continue;
    }
    if (line.startsWith('# branch.head ')) {
      const head = line.slice('# branch.head '.length).trim();
      if (head === '(detached)') detached = true;
      else branch = head;
      continue;
    }
    if (line.startsWith('# branch.ab ')) {
      const [plus, minus] = line.slice('# branch.ab '.length).trim().split(/\s+/);
      ahead = countOf(plus);
      behind = countOf(minus);
      continue;
    }
    if (line.startsWith('#')) continue;
    // `!` — игнорируемый файл: без `--ignored` его в выводе нет, но если он
    // всё же пришёл, изменением он не считается.
    if (line.startsWith('! ')) continue;

    const change = parseChange(line);
    if (!change) continue;
    dirtyCount += 1;
    if (line.startsWith('2 ')) {
      // Прежний путь переименования лежит отдельным полем следом за записью.
      const from = entries[index + 1];
      index += 1;
      if (from) change.from = from;
    }
    if (changedFiles.length < CHANGED_FILES_MAX) changedFiles.push(change);
  }

  return {
    branch,
    detached,
    unborn,
    dirtyCount,
    changedFiles,
    changedFilesTruncated: dirtyCount > changedFiles.length,
    ahead,
    behind,
  };
}

/**
 * Куда ходить за чужими коммитами. `origin` — если он есть: это имя по
 * умолчанию у всех, кто клонировал репозиторий. Иначе первый по алфавиту, и
 * это лучше, чем молча не показать кнопку у репозитория с одним `upstream`.
 */
export function pickRemote(stdout: string): string | undefined {
  const names = stdout
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .sort((a, b) => a.localeCompare(b));
  return names.includes('origin') ? 'origin' : names[0];
}

/**
 * Ветки выбранного удалённого, без префикса `<remote>/`. `origin/HEAD` — это
 * не ветка, а указатель на ветку по умолчанию; тянуть по нему нечего.
 */
export function parseRemoteBranches(stdout: string, remote: string | undefined): string[] {
  if (!remote) return [];
  const prefix = `${remote}/`;
  return stdout
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.startsWith(prefix))
    .map((line) => line.slice(prefix.length))
    .filter((name) => name && name !== 'HEAD')
    .sort((a, b) => a.localeCompare(b));
}

/** Локальные ветки по алфавиту. Удалённых нет: переключаемся только по локальным. */
export function parseBranches(stdout: string): string[] {
  return stdout
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .sort((a, b) => a.localeCompare(b));
}
