import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import type { ProjectGitInfo } from '@claude-control/contracts';

/**
 * Git выбранного проекта: где я сейчас, куда переключиться, как завести ветку и
 * закоммитить. Ровно четыре операции — `status`, `checkout`, `checkout -b`,
 * `commit`; слияния, ребейзы, пуши и удаление веток панель не делает намеренно.
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
  return { isRepo: false, detached: false, unborn: false, branches: [], dirtyCount: 0 };
}

/**
 * Запустить git в каталоге проекта. Оболочки нет: аргументы идут массивом.
 * Вывод stderr при ненулевом коде — это и есть человеческое объяснение git
 * («ветка уже существует», «не задан user.email»), поэтому оно и уходит наверх.
 */
async function git(projectDir: string, args: string[]): Promise<string> {
  try {
    const { stdout } = await execFileAsync('git', args, {
      cwd: resolve(projectDir),
      timeout: GIT_TIMEOUT_MS,
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

/**
 * Разбор `git status --porcelain=v2 --branch`. Один вызов отвечает сразу на
 * три вопроса: какая ветка, отцеплен ли HEAD, сколько файлов изменено, — а
 * заголовок `# branch.oid (initial)` отличает репозиторий без коммитов.
 */
export function parseStatus(stdout: string): {
  branch?: string;
  detached: boolean;
  unborn: boolean;
  dirtyCount: number;
} {
  let branch: string | undefined;
  let detached = false;
  let unborn = false;
  let dirtyCount = 0;

  for (const raw of stdout.split('\n')) {
    const line = raw.replace(/\r$/, '');
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
    // Служебные заголовки не считаем; всё остальное — изменённый файл
    // (`1`/`2` — учтённые и переименования, `u` — конфликт, `?` — неучтённый,
    // `!` — игнорируемый, но без `--ignored` его в выводе нет).
    if (!line.startsWith('#')) dirtyCount += 1;
  }

  return { branch, detached, unborn, dirtyCount };
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
    const [statusOut, branchesOut] = await Promise.all([
      git(projectDir, ['status', '--porcelain=v2', '--branch']),
      git(projectDir, ['for-each-ref', '--format=%(refname:short)', 'refs/heads']),
    ]);
    const status = parseStatus(statusOut);
    return {
      isRepo: true,
      detached: status.detached,
      unborn: status.unborn,
      branches: parseBranches(branchesOut),
      dirtyCount: status.dirtyCount,
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
