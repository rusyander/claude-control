import { spawn as nodeSpawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { shellArgs } from './cli-args.ts';
import { resolveWindowsExecutable, cmdWouldTruncate } from './win-exec.ts';

/**
 * Запуск CLI провайдера без shell-интерполяции — общий для всех, кто запускает
 * чужой CLI: и для одноразового ответа, и для потокового чата.
 *
 * На POSIX это буквально argv-массив: оболочки нет, метасимволы разбирать
 * некому.
 *
 * На Windows иначе: команда-обёртка (`*.cmd`) запускается только через
 * `cmd.exe`, а он РАЗБИРАЕТ полученную строку заново. Передавать туда argv-
 * массив в расчёте на квотирование Node нельзя: libuv берёт в кавычки только
 * аргументы с пробелом, табом или кавычкой. Промпт без пробелов, зато с `&`,
 * `|`, `>` или `^` доходил до cmd.exe голым: `2+2>4?` перенаправлялся в файл, а
 * `a&whoami` запускал вторую команду правами сервера. Промпт попадает в argv у
 * всех провайдеров, кроме claude, так что случай не редкий.
 *
 * Поэтому строку командной строки собираем сами — тем же `shellArgs`, что и
 * ChatRunner: через оболочку идёт либо ОДНА строка, либо `shellArgs`, но не
 * сырой массив. Внешняя пара кавычек и `windowsVerbatimArguments` нужны в паре:
 * без флага libuv заквотировал бы уже заквотированное по второму разу, а `/s`
 * снимает ровно эту внешнюю пару. `/v:off` добивает `!ИМЯ!`: при включённом
 * отложенном разворачивании оно подставляется даже внутри кавычек.
 *
 * Но и с идеальными кавычками cmd.exe остаётся плохим посредником: `%ИМЯ%` он
 * подставит из окружения, а на первом переводе строки ОБРЕЖЕТ команду и молча
 * (код 0) выполнит только первую строку. Поэтому сперва ищем настоящий `.exe` и
 * запускаем его БЕЗ оболочки: argv уходит как есть. Обёртка `.cmd` без `.exe`
 * рядом — единственный случай, когда cmd.exe всё ещё нужен, и там мы лучше
 * откажемся с внятной ошибкой, чем отправим обрубок промпта и выдадим ответ на
 * него за полный.
 */

/**
 * Платформа — ФУНКЦИЯ, а не константа модуля: константа замерла бы на импорте, и
 * подменить `process.platform` в кроссплатформенном тесте было бы нечем.
 */
function isWindows(): boolean {
  return process.platform === 'win32';
}

export interface CliSpawnOptions {
  /** Подменяемый spawn — в тестах ничего настоящего не запускается. */
  spawnImpl?: typeof nodeSpawn;
  /** Рабочий каталог процесса. Не задан — каталог сервера. */
  cwd?: string;
}

/** Либо запущенный процесс, либо причина, по которой запускать не стали. */
export type CliSpawnOutcome =
  | { child: ChildProcessWithoutNullStreams; error?: undefined }
  | { child?: undefined; error: Error };

export function spawnCliProcess(
  command: string,
  args: string[],
  options: CliSpawnOptions = {},
): CliSpawnOutcome {
  const spawnImpl = options.spawnImpl ?? nodeSpawn;
  const base = { windowsHide: true, ...(options.cwd ? { cwd: options.cwd } : {}) };

  try {
    if (!isWindows()) {
      return { child: spawnImpl(command, args, base) as ChildProcessWithoutNullStreams };
    }

    const direct = resolveWindowsExecutable(command);
    if (direct) {
      return { child: spawnImpl(direct, args, base) as ChildProcessWithoutNullStreams };
    }

    if (cmdWouldTruncate(args)) {
      return {
        error: new Error(
          `«${command}» установлен как .cmd-обёртка, а через неё Windows обрезает команду ` +
            'на первом переводе строки — многострочный запрос дошёл бы обрубком. ' +
            'Поставьте нативный исполняемый файл CLI или задайте запрос одной строкой.',
        ),
      };
    }

    const comspec = process.env.ComSpec || 'cmd.exe';
    const line = shellArgs([command, ...args]).join(' ');
    const child = spawnImpl(comspec, ['/d', '/s', '/v:off', '/c', `"${line}"`], {
      ...base,
      windowsVerbatimArguments: true,
    }) as ChildProcessWithoutNullStreams;

    return { child };
  } catch (error) {
    return { error: error instanceof Error ? error : new Error(String(error)) };
  }
}
