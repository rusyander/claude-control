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
  /**
   * Добавка к окружению процесса — адрес шлюза контура (Т3) и больше ничего.
   *
   * ДОБАВКА, а не замена: `process.env` остаётся целиком. Собственное
   * окружение CLI — это его PATH, домашний каталог и вход в аккаунт; отдать ему
   * три переменные вместо них значило бы не «направить в контур», а сломать
   * запуск.
   */
  env?: Record<string, string>;
  /**
   * Переменные и ключи переносимой среды (П3.5) — ФУНКЦИЯ, а не объект.
   *
   * Собирает её `portability/supervisor/env-inject.ts`, и зовётся она в момент
   * запуска. Строкой значение ключа сюда попасть не может намеренно: параметры
   * прогона панель СОХРАНЯЕТ (остановленный прогон продолжается ими же и
   * переживает перезапуск), и ключ, положенный полем, уехал бы в `state.json` —
   * то есть ровно туда, где секрета быть не должно. Функция такого переезда не
   * переживает, и окружение собирается заново — как заново пересобирается
   * маршрут контура.
   */
  portableEnv?: () => Record<string, string>;
  /**
   * `false` — `env` и есть ВСЁ окружение процесса, без `process.env` сервера.
   * Для агента панели: его CLI не должен унаследовать ни ключ API, ни переменные
   * контура и интеграций, лежащие в окружении панели. Список нужного CLI собирает
   * вызывающий (`panel-agent/runner.ts → panelAgentEnv`).
   */
  inheritEnv?: boolean;
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

  try {
    // Канон переносимой среды ложится ПОД `options.env`: адрес шлюза контура
    // сильнее переменной из файла цели — иначе перенесённый `OPENAI_BASE_URL`
    // увёл бы трафик мимо контура. Сборка внутри try: у запуска один ответ
    // (`CliSpawnOutcome`), и падение сборщика окружения обязано приехать
    // ошибкой, а не исключением наружу.
    const extra = { ...options.portableEnv?.(), ...options.env };

    // `env` уходит в spawn ТОЛЬКО целиком: node не умеет «добавить переменную», он
    // заменяет окружение целиком. Поэтому добавку кладём поверх копии process.env —
    // иначе CLI лишился бы PATH и входа в аккаунт. Добавки нет — `env` не
    // передаём вовсе, чтобы ребёнок унаследовал окружение сервера как раньше.
    const base = {
      windowsHide: true,
      ...(options.cwd ? { cwd: options.cwd } : {}),
      ...(options.inheritEnv === false
        ? { env: extra }
        : Object.keys(extra).length > 0
          ? { env: { ...process.env, ...extra } }
          : {}),
    };

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
