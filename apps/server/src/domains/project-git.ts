import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import type {
  ProjectGitChange,
  ProjectGitFileStatus,
  ProjectGitInfo,
} from '@claude-control/contracts';

/**
 * Git выбранного проекта: где я сейчас, что изменено, куда переключиться, как
 * завести ветку, закоммитить и подтянуть чужое. Пять операций — `status`,
 * `checkout`, `checkout -b`, `commit`, `pull`; пуши, ребейзы и удаление веток
 * панель не делает намеренно.
 *
 * `pull` — единственная сетевая операция и единственная, после которой рабочее
 * дерево может остаться в конфликте. Панель его не разрешает и не откатывает:
 * она передаёт вывод git как есть, дальше человек идёт в терминал. Обрезать это
 * до `--ff-only` было бы честнее, но выбор сделан в пользу поведения обычного
 * `git pull` — так кнопка не врёт про то, чем она является.
 *
 * ПОЯВЛЯЕТСЯ ТОЛЬКО ПРИ `.git` в каталоге проекта. Проверяем именно вхождение
 * `.git`, а не запуском git: в рабочем дереве worktree это ФАЙЛ, а не каталог,
 * поэтому `existsSync` без `isDirectory`. Нет `.git` — `isRepo:false`, и клиент
 * не рисует пульт вовсе (не «пустой git», а отсутствие раздела).
 *
 * БЕЗОПАСНОСТЬ. Оболочки нет нигде: `execFile('git', [...])` передаёт аргументы
 * массивом, поэтому ни имя ветки, ни текст коммита не могут стать командой.
 * Сверх этого имя ветки проходит через `git check-ref-format --branch` — это
 * задокументированная проверка самого git, и придумывать свою грамматику имён
 * поверх неё незачем. Переключение разрешено только на СУЩЕСТВУЮЩУЮ локальную
 * ветку из списка: иначе `checkout <что угодно>` отцепил бы HEAD на произвольный
 * коммит, чего никто не просил.
 */

const execFileAsync = promisify(execFile);

/** Потолок ожидания одной команды git. Хуки коммита бывают долгими, но не вечными. */
const GIT_TIMEOUT_MS = 60_000;
/** Для `pull` потолок другой: это поход в сеть, а не локальная операция. */
const GIT_NETWORK_TIMEOUT_MS = 180_000;
/**
 * Сколько изменённых файлов показываем списком. Полное число живёт в
 * `dirtyCount` и не обрезается: счётчик обязан быть честным, даже когда список
 * не поместился. Потолок нужен, чтобы после массового переформатирования ответ
 * не превратился в мегабайт путей, которые никто не прочитает.
 */
export const CHANGED_FILES_MAX = 500;
/** Потолок вывода: список веток огромного репозитория не должен съесть память. */
const GIT_MAX_BUFFER = 4 * 1024 * 1024;
/** Длина сообщения коммита: с запасом на подробное описание, но не безразмерно. */
export const COMMIT_MESSAGE_MAX = 2000;

/** Управляющие символы (кроме перевода строки) — их не должно быть во вводе. */
// eslint-disable-next-line no-control-regex -- проверка на управляющие символы и есть смысл выражения
const CONTROL_CHARS = /[\u0000-\u0009\u000b-\u001f\u007f]/;
/** То же плюс пробельные — для имени ветки, где пробелов быть не может вовсе. */
// eslint-disable-next-line no-control-regex -- см. выше
const BRANCH_FORBIDDEN = /[\s\u0000-\u001f\u007f]/;

/** Ошибка операции git с человеческим текстом — маршрут превращает её в 400. */
export class GitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GitError';
  }
}

/** В каталоге проекта есть `.git` (каталог или файл рабочего дерева worktree). */
export function isGitRepo(projectDir: string): boolean {
  return Boolean(projectDir.trim()) && existsSync(join(projectDir, '.git'));
}

/** Пустое состояние «это не репозиторий» — им же отвечаем и при отсутствии каталога. */
function notARepo(): ProjectGitInfo {
  return {
    isRepo: false,
    detached: false,
    unborn: false,
    branches: [],
    dirtyCount: 0,
    changedFiles: [],
    remoteBranches: [],
  };
}

/**
 * Запустить git в каталоге проекта. Оболочки нет: аргументы идут массивом.
 * Вывод stderr при ненулевом коде — это и есть человеческое объяснение git
 * («ветка уже существует», «не задан user.email»), поэтому оно и уходит наверх.
 */
async function git(projectDir: string, args: string[], timeout = GIT_TIMEOUT_MS): Promise<string> {
  try {
    const { stdout } = await execFileAsync('git', args, {
      cwd: resolve(projectDir),
      timeout,
      maxBuffer: GIT_MAX_BUFFER,
      windowsHide: true,
    });
    return stdout;
  } catch (error) {
    const shell = error as { stderr?: string; stdout?: string; code?: string; message?: string };
    if (shell.code === 'ENOENT') {
      throw new GitError('Команда git не найдена. Установите git или добавьте его в PATH.');
    }
    const text = (shell.stderr || shell.stdout || shell.message || '').trim();
    throw new GitError(text || 'Команда git завершилась с ошибкой');
  }
}

/** Буква из `XY` порядкового статуса → человеческое состояние файла. */
const STATUS_BY_CODE: Record<string, ProjectGitFileStatus> = {
  A: 'added',
  M: 'modified',
  D: 'deleted',
  R: 'renamed',
  C: 'renamed',
  T: 'typechange',
};

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

/**
 * Состояние репозитория проекта. Нет `.git` — `isRepo:false`. Git есть, но
 * ответил ошибкой — `isRepo:true` + `error`: пульт покажет причину и ничего
 * писать не даст (сломанный репозиторий — не повод угадывать).
 */
export async function readProjectGit(projectDir: string): Promise<ProjectGitInfo> {
  if (!isGitRepo(projectDir)) return notARepo();

  try {
    // Четыре чтения независимы, поэтому идут разом: последовательно они
    // растянули бы обновление пульта на каждый фокус окна.
    const [statusOut, branchesOut, remotesOut, remoteRefsOut] = await Promise.all([
      git(projectDir, ['status', '--porcelain=v2', '--branch', '-z']),
      git(projectDir, ['for-each-ref', '--format=%(refname:short)', 'refs/heads']),
      git(projectDir, ['remote']),
      git(projectDir, ['for-each-ref', '--format=%(refname:short)', 'refs/remotes']),
    ]);
    const status = parseStatus(statusOut);
    const remote = pickRemote(remotesOut);
    return {
      isRepo: true,
      detached: status.detached,
      unborn: status.unborn,
      branches: parseBranches(branchesOut),
      dirtyCount: status.dirtyCount,
      changedFiles: status.changedFiles,
      remoteBranches: parseRemoteBranches(remoteRefsOut, remote),
      ...(status.changedFilesTruncated ? { changedFilesTruncated: true } : {}),
      ...(remote ? { remote } : {}),
      ...(status.ahead === undefined ? {} : { ahead: status.ahead }),
      ...(status.behind === undefined ? {} : { behind: status.behind }),
      ...(status.branch ? { branch: status.branch } : {}),
    };
  } catch (error) {
    return {
      ...notARepo(),
      isRepo: true,
      error: error instanceof GitError ? error.message : String(error),
    };
  }
}

/** Каталог проекта пригоден для операции записи, иначе — GitError с причиной. */
async function requireRepo(projectDir: string): Promise<ProjectGitInfo> {
  if (!isGitRepo(projectDir)) {
    throw new GitError('В каталоге проекта нет .git — это не репозиторий');
  }
  const info = await readProjectGit(projectDir);
  if (info.error) throw new GitError(info.error);
  return info;
}

/**
 * Имя ветки проверяет сам git (`check-ref-format --branch`) — это его правила,
 * а не наши догадки. Дешёвая проверка перед этим отсекает пустое имя, пробелы и
 * ведущий дефис: последний git принял бы за флаг.
 */
export async function assertBranchName(projectDir: string, name: string): Promise<void> {
  const value = name.trim();
  if (!value) throw new GitError('Имя ветки не задано');
  if (value.length > 200) throw new GitError('Имя ветки слишком длинное');
  if (value.startsWith('-')) throw new GitError('Имя ветки не может начинаться с дефиса');
  if (BRANCH_FORBIDDEN.test(value)) {
    throw new GitError('В имени ветки не должно быть пробелов и управляющих символов');
  }
  try {
    await git(projectDir, ['check-ref-format', '--branch', value]);
  } catch {
    throw new GitError(`git не принимает такое имя ветки: ${value}`);
  }
}

/**
 * Переключиться на СУЩЕСТВУЮЩУЮ локальную ветку. Имя сверяется со списком, а не
 * передаётся в git как есть: `checkout <произвольная ссылка>` отцепил бы HEAD.
 * `--` в конце снимает двусмысленность «ветка или файл с таким же именем».
 */
export async function checkoutBranch(projectDir: string, branch: string): Promise<string> {
  const info = await requireRepo(projectDir);
  const value = branch.trim();
  if (!info.branches.includes(value)) {
    throw new GitError(`Ветки ${value} нет среди локальных`);
  }
  if (value === info.branch) return `Уже на ветке ${value}`;
  const out = await git(projectDir, ['checkout', value, '--']);
  return out.trim() || `Переключено на ветку ${value}`;
}

/**
 * Создать ветку от текущего HEAD и перейти на неё. Незакоммиченные правки git
 * переносит сам — это его обычное поведение, и панель его не подменяет.
 */
export async function createBranch(projectDir: string, name: string): Promise<string> {
  const info = await requireRepo(projectDir);
  const value = name.trim();
  await assertBranchName(projectDir, value);
  if (info.branches.includes(value)) throw new GitError(`Ветка ${value} уже существует`);
  if (info.unborn) {
    throw new GitError('В репозитории ещё нет коммитов — сначала сделайте первый коммит');
  }
  const out = await git(projectDir, ['checkout', '-b', value]);
  return out.trim() || `Создана ветка ${value}`;
}

/**
 * Подтянуть чужие коммиты. Без имени ветки — обычный `git pull` в текущей: он
 * сам знает свой upstream, и подставлять что-то вместо него панель не вправе.
 * С именем — `git pull <remote> <branch>`, причём имя обязано быть из списка
 * веток этого удалённого: как и у checkout, в git уходит только то, что git же
 * и перечислил, а не строка из запроса.
 *
 * Слияние здесь возможно, и это осознанно (см. заголовок файла). Конфликт —
 * не ошибка панели: git вернёт ненулевой код, его текст уйдёт пользователем как
 * есть, а рабочее дерево останется в конфликте до ручного разбора.
 */
export async function pullChanges(projectDir: string, branch?: string): Promise<string> {
  const info = await requireRepo(projectDir);
  if (info.unborn) {
    throw new GitError('В репозитории ещё нет коммитов — тянуть некуда');
  }
  const value = branch?.trim();

  if (!value) {
    if (info.detached) {
      throw new GitError(
        'HEAD отцеплен от ветки — переключитесь на ветку или выберите её в списке',
      );
    }
    const out = await git(projectDir, ['pull'], GIT_NETWORK_TIMEOUT_MS);
    return out.trim() || 'Обновлено';
  }

  if (!info.remote) {
    throw new GitError('У репозитория нет удалённых — тянуть неоткуда');
  }
  if (!info.remoteBranches.includes(value)) {
    throw new GitError(`Ветки ${value} нет на ${info.remote}`);
  }
  const out = await git(projectDir, ['pull', info.remote, value], GIT_NETWORK_TIMEOUT_MS);
  return out.trim() || `Обновлено из ${info.remote}/${value}`;
}

/**
 * Закоммитить ВСЕ изменения рабочего дерева: `add -A`, затем `commit -m`.
 * Выборочного индекса в панели нет намеренно — это работа для полноценного
 * git-клиента, а здесь пульт на три кнопки.
 */
export async function commitAll(projectDir: string, message: string): Promise<string> {
  const info = await requireRepo(projectDir);
  const text = message.trim();
  if (!text) throw new GitError('Сообщение коммита пустое');
  if (text.length > COMMIT_MESSAGE_MAX) {
    throw new GitError(`Сообщение коммита длиннее ${COMMIT_MESSAGE_MAX} символов`);
  }
  if (CONTROL_CHARS.test(text)) {
    throw new GitError('В сообщении коммита есть управляющие символы');
  }
  if (info.dirtyCount === 0) throw new GitError('Нечего коммитить — изменений нет');

  await git(projectDir, ['add', '-A']);
  const out = await git(projectDir, ['commit', '-m', text]);
  return out.trim() || 'Коммит создан';
}
