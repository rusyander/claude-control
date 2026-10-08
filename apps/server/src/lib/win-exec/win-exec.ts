import { existsSync, statSync } from 'node:fs';
import { delimiter, isAbsolute, join, extname, basename } from 'node:path';

/**
 * Поиск НАСТОЯЩЕГО исполняемого файла на Windows.
 *
 * Зачем: `.cmd`-обёртку (так ставит пакеты npm) без `cmd.exe` не запустить, а
 * `cmd.exe` разбирает полученную строку по своим правилам — и делает это до
 * того, как строка дойдёт до CLI. Кавычки от инъекции спасают, но две вещи
 * кавычками не лечатся: `%ИМЯ%` он подставит из окружения, а на первом же
 * переводе строки ОБРЕЖЕТ команду и выполнит только первую строку (код выхода
 * при этом 0 — то есть молча). Промпт склеивается из истории через «\n\n»,
 * так что под обрезание попадает почти любой второй вопрос подряд.
 *
 * Настоящий `.exe` запускается напрямую, без оболочки: argv уходит в процесс
 * как есть, и разбирать его некому. Поэтому перед `cmd.exe` всегда ищем `.exe`
 * — у codex, opencode, aider и самого claude он обычно есть.
 */

/** Расширения, которые CreateProcess запускает без оболочки. */
const DIRECT_EXTENSIONS = ['.exe', '.com'];

function isFile(path: string): boolean {
  try {
    return existsSync(path) && statSync(path).isFile();
  } catch {
    return false;
  }
}

/**
 * `codex.cmd` → `codex`: имя без расширения обёртки. Имя вида `my.tool` не
 * трогаем — точка в нём не расширение.
 */
function bareName(command: string): string {
  const ext = extname(command).toLowerCase();
  return ext === '.cmd' || ext === '.bat' || ext === '.ps1'
    ? command.slice(0, -ext.length)
    : command;
}

/**
 * Путь к исполняемому файлу, который можно запустить БЕЗ оболочки, или
 * undefined — тогда вызывающий идёт через `cmd.exe` со всеми его оговорками.
 *
 * `env` передаётся явно: в тестах подменяется PATH, а брать его из глобального
 * `process` внутри функции значило бы, что проверить поведение нечем.
 */
export function resolveWindowsExecutable(
  command: string,
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  const ext = extname(command).toLowerCase();

  // Путь уже указан явно: проверяем ровно его, PATH не при чём.
  if (isAbsolute(command) || command.includes('/') || command.includes('\\')) {
    if (DIRECT_EXTENSIONS.includes(ext)) return isFile(command) ? command : undefined;
    // Рядом с обёрткой `…\codex.cmd` обычно лежит `…\codex.exe`.
    const near = bareName(command);
    return DIRECT_EXTENSIONS.map((candidate) => `${near}${candidate}`).find(isFile);
  }

  const base = bareName(basename(command));
  const dirs = (env.PATH ?? env.Path ?? '').split(delimiter).filter(Boolean);

  for (const dir of dirs) {
    for (const candidate of DIRECT_EXTENSIONS) {
      const path = join(dir, `${base}${candidate}`);
      if (isFile(path)) return path;
    }
  }

  return undefined;
}

/**
 * Что `cmd.exe` испортит молча. Инъекции тут нет — кавычки и `/v:off` её
 * закрывают, — но перевод строки обрезает команду, и CLI получит обрубок
 * промпта, а панель покажет ответ как полноценный.
 */
export function cmdWouldTruncate(args: readonly string[]): boolean {
  return args.some((arg) => /[\r\n]/.test(arg));
}
