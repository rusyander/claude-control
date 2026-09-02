import { execFile } from 'node:child_process';
import { resolve } from 'node:path';
import { promisify } from 'node:util';
import { GIT_MAX_BUFFER, GIT_TIMEOUT_MS } from './constants.ts';

/**
 * Запуск git. Оболочки нет нигде: `execFile('git', [...])` передаёт аргументы
 * массивом, поэтому ни имя ветки, ни текст коммита не могут стать командой.
 */

const execFileAsync = promisify(execFile);

/**
 * Windows отказывается создавать путь длиннее 260 символов, и `worktree add`
 * умирает посреди выкладки файлов: «Filename too long». Своих путей панель
 * укорачивает сколько может (`worktreeDirName`), но глубину чужого репозитория
 * она не выбирает — у настоящих фронтендов вложенность каталогов сама по себе
 * бывает под две сотни символов.
 *
 * `core.longpaths` — родное лекарство Git for Windows: он переходит на юникодные
 * API с префиксом `\\?\` и перестаёт упираться в 260. Ставим ключом запуска
 * (`-c`), а не записью в конфиг: чужой репозиторий не наш, чтобы его настраивать,
 * и на следующем запуске всё равно всё нужное будет передано снова.
 */
const LONG_PATHS_ARGS = process.platform === 'win32' ? ['-c', 'core.longpaths=true'] : [];

/**
 * Убрать из вывода git полосу прогресса. Она рисуется возвратом каретки в одну
 * строку терминала, а в перехваченном виде разворачивается в простыню
 * «Updating files: 20% (1614/7829)…», внутри которой настоящая причина отказа
 * теряется — именно её человек и должен прочитать в уведомлении.
 */
const PROGRESS_LINE =
  /^\s*(remote:\s*)?(Updating files|Receiving objects|Resolving deltas|Counting objects|Compressing objects|Enumerating objects|Unpacking objects|Checking out files|Filtering content)\s*:/;

export function stripGitProgress(text: string): string {
  return text
    .split(/\r?\n/)
    .map((line) => line.split('\r').at(-1) ?? line)
    .filter((line) => !PROGRESS_LINE.test(line))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** Ошибка операции git с человеческим текстом — маршрут превращает её в 400. */
export class GitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GitError';
  }
}

/**
 * Запустить git в каталоге проекта. Оболочки нет: аргументы идут массивом.
 * Вывод stderr при ненулевом коде — это и есть человеческое объяснение git
 * («ветка уже существует», «не задан user.email»), поэтому оно и уходит наверх.
 */
export async function git(
  projectDir: string,
  args: string[],
  timeout = GIT_TIMEOUT_MS,
): Promise<string> {
  try {
    const { stdout } = await execFileAsync('git', [...LONG_PATHS_ARGS, ...args], {
      cwd: resolve(projectDir),
      timeout,
      maxBuffer: GIT_MAX_BUFFER,
      windowsHide: true,
      // Спрашивать логин и пароль не у кого: процесс без терминала, и запрос
      // credentials висел бы до самого таймаута. С этим флагом git сразу
      // сдаётся и объясняет причину — она и уходит пользователю.
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
    });
    return stdout;
  } catch (error) {
    const shell = error as { stderr?: string; stdout?: string; code?: string; message?: string };
    if (shell.code === 'ENOENT') {
      throw new GitError('Команда git не найдена. Установите git или добавьте его в PATH.');
    }
    const text = stripGitProgress(shell.stderr || shell.stdout || shell.message || '');
    throw new GitError(text || 'Команда git завершилась с ошибкой');
  }
}
