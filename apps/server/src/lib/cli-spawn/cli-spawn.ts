import { spawn as nodeSpawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { errorMonitor } from 'node:events';
import { StringDecoder } from 'node:string_decoder';
import { shellArgs } from '../cli-args/cli-args.ts';
import { wasStoppedOnPurpose } from '../process-tree/process-tree.ts';
import { resolveWindowsExecutable, cmdWouldTruncate } from '../win-exec/win-exec.ts';
import { resolveWindowsShim } from '../win-shim.ts';

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
 * запускаем его БЕЗ оболочки: argv уходит как есть. Нет `.exe` — разбираем
 * `.cmd`-обёртку npm/pnpm/yarn (`win-shim.ts`): она лишь зовёт `node <скрипт>
 * %*` (или нативный бинарь), и ту же цель мы запускаем сами, тоже без
 * оболочки. cmd.exe остаётся только для обёртки, которую мы не узнали, и там
 * многострочный промпт мы лучше отклоним с внятной ошибкой, чем отправим
 * обрубок и выдадим ответ на него за полный.
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

/**
 * Наблюдатель за НЕУДАВШИМИСЯ запусками — для фонового наблюдателя панели:
 * «CLI не запустился» — один из сбоев, о которых он пишет отчёт. Один на
 * процесс, по умолчанию его нет, и тогда запуск ничем не отличается от
 * прежнего. Ошибку процесса смотрим через `errorMonitor`: обычный слушатель
 * `error` проглотил бы её у вызывающего, который своего не повесил, и поменял
 * бы поведение — падение превратилось бы в тишину.
 */
export type SpawnFailureObserver = (command: string, error: Error) => void;
let spawnFailureObserver: SpawnFailureObserver | undefined;

export function observeSpawnFailures(observer: SpawnFailureObserver | undefined): void {
  spawnFailureObserver = observer;
}

function notifySpawnFailure(command: string, error: Error): void {
  try {
    spawnFailureObserver?.(command, error);
  } catch {
    // Наблюдатель не имеет права ронять запуск.
  }
}

/**
 * Наблюдатель за CLI, завершившимися с НЕНУЛЕВЫМ кодом, — так до фонового
 * наблюдателя доходят и ошибки провайдера: CLI сообщает о них кодом выхода.
 * Снятые нарочно (стоп, выключение, таймаут) не в счёт: сигнал выхода, флаг
 * `killed` или отметка `process-tree` о снятии дерева. Слушатель `exit` ничего
 * не меняет у вызывающего: у события нет поведения по умолчанию.
 */
export interface CliExit {
  command: string;
  args: readonly string[];
  code: number;
  pid?: number;
  /**
   * Конец stderr (до `STDERR_TAIL_MAX` знаков) — то, что прочитал вызывающий;
   * непрочитанное дочитывает сам Node на выходе процесса, и оно тоже здесь.
   */
  stderr?: string;
}
const STDERR_TAIL_MAX = 4000;
export type CliExitObserver = (exit: CliExit) => void;
let cliExitObserver: CliExitObserver | undefined;

export function observeCliExits(observer: CliExitObserver | undefined): void {
  cliExitObserver = observer;
}

/**
 * Хвост stderr без вмешательства в поток: подсматривается `emit('data')`, а
 * не вешается слушатель — слушатель перевёл бы поток в «течёт», и вызывающий,
 * который читает позже, потерял бы начало. Данные видны ровно тогда, когда их
 * читает сам вызывающий.
 */
function stderrTail(child: ChildProcessWithoutNullStreams): () => string {
  let tail = '';
  // Декодер держит недописанные байты буквы до следующего куска: `String(chunk)`
  // по кускам превращал разрезанную русскую букву в U+FFFD (F-207).
  const decoder = new StringDecoder('utf8');
  const stream = child.stderr as (NodeJS.ReadableStream & { emit?: unknown }) | undefined;
  if (!stream || typeof stream.emit !== 'function') return () => tail;
  const emit = stream.emit.bind(stream) as (event: string | symbol, ...rest: unknown[]) => boolean;
  (stream as { emit: typeof emit }).emit = (event, ...rest) => {
    if (event === 'data') {
      try {
        const chunk = Buffer.isBuffer(rest[0]) ? decoder.write(rest[0]) : String(rest[0]);
        tail = (tail + chunk).slice(-STDERR_TAIL_MAX);
      } catch {
        // Хвост — улика, а не условие работы.
      }
    }
    return emit(event, ...rest);
  };
  return () => tail;
}

/**
 * Тот же присмотр за выходом для CLI, запущенного мимо `spawnCliProcess`
 * (свой `spawn` у чата): ненулевой код и хвост stderr уходят наблюдателю.
 * Без наблюдателя — ничего не вешает. Вызывать сразу после `spawn`, до чтения
 * stderr, — иначе начало хвоста мимо.
 */
export function watchCliChild(
  command: string,
  args: readonly string[],
  child: ChildProcessWithoutNullStreams,
): void {
  if (cliExitObserver) watchExit(command, args, child);
}

function watchExit(
  command: string,
  args: readonly string[],
  child: ChildProcessWithoutNullStreams,
): void {
  const tail = stderrTail(child);
  // `close`, а не `exit`: к нему потоки уже дочитаны — хвост stderr полный.
  child.on?.('close', (code: number | null, signal: NodeJS.Signals | null) => {
    if (!cliExitObserver || code === null || code === 0 || signal !== null) return;
    if (child.killed || (child.pid !== undefined && wasStoppedOnPurpose(child.pid))) return;
    try {
      const stderr = tail().trim();
      cliExitObserver({
        command,
        args,
        code,
        ...(child.pid !== undefined ? { pid: child.pid } : {}),
        ...(stderr ? { stderr } : {}),
      });
    } catch {
      // Наблюдатель не имеет права ронять запуск.
    }
  });
}

export function spawnCliProcess(
  command: string,
  args: string[],
  options: CliSpawnOptions = {},
): CliSpawnOutcome {
  const outcome = spawnUnobserved(command, args, options);
  if (!spawnFailureObserver && !cliExitObserver) return outcome;
  if (outcome.error) notifySpawnFailure(command, outcome.error);
  else {
    outcome.child.on?.(errorMonitor, (error: Error) => notifySpawnFailure(command, error));
    watchExit(command, args, outcome.child);
  }
  return outcome;
}

/**
 * `NODE_PATH`, который обёртка pnpm выставила бы сама: её значение, а уже
 * заданный — следом через `;`, ровно как в её ветке `ELSE`. Окружение
 * берётся то, что ушло бы ребёнку, — иначе `inheritEnv: false` протёк бы.
 */
function withNodePath<T extends { env?: NodeJS.ProcessEnv }>(base: T, nodePath: string): T {
  const env = base.env ?? process.env;
  const current = env.NODE_PATH;
  return { ...base, env: { ...env, NODE_PATH: current ? `${nodePath};${current}` : nodePath } };
}

function spawnUnobserved(
  command: string,
  args: string[],
  options: CliSpawnOptions,
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

    // Обёртка npm/pnpm/yarn — это `node <скрипт> %*`: тот же node с тем же
    // скриптом запускаем сами, без cmd.exe, и argv доходит как есть.
    const shim = resolveWindowsShim(command);
    if (shim) {
      return {
        child: spawnImpl(
          shim.file,
          [...shim.prefix, ...args],
          shim.nodePath === undefined ? base : withNodePath(base, shim.nodePath),
        ) as ChildProcessWithoutNullStreams,
      };
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
