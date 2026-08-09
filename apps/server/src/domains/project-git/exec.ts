import { execFile } from 'node:child_process';
import { resolve } from 'node:path';
import { promisify } from 'node:util';
import { GIT_MAX_BUFFER, GIT_TIMEOUT_MS } from './constants.ts';

/**
 * Запуск git. Оболочки нет нигде: `execFile('git', [...])` передаёт аргументы
 * массивом, поэтому ни имя ветки, ни текст коммита не могут стать командой.
 */

const execFileAsync = promisify(execFile);

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
    const { stdout } = await execFileAsync('git', args, {
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
    const text = (shell.stderr || shell.stdout || shell.message || '').trim();
    throw new GitError(text || 'Команда git завершилась с ошибкой');
  }
}
