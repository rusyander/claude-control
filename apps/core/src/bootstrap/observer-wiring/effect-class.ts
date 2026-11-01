import type { PermissionAsk } from '../../adapters/adapter.types.ts';
import { commandName } from '../../policy/permit/exec-argv.ts';
import { parseBash } from '../../policy/permit/exec-argv/bash.ts';
import type { ParsedScript } from '../../policy/permit/exec-argv/exec-argv.types.ts';
import { parsePowerShell } from '../../policy/permit/exec-argv/foreign.ts';
import { canonicalTarget } from '../../policy/permit/target-path.ts';
import { currentOs, type OsKind } from '../../platform/os-kind.ts';
import { isAbsolutePath, joinPath } from '../../platform/paths.ts';

/**
 * Класс действия вызова инструмента для предикатов расточительства (этап 8, 06:134-137): что вызов
 * СДЕЛАЛ, а не как называется. Чистая функция над вопросом о праве переходника (`PermissionAsk`) и
 * разбором строки оболочки (`exec-argv`): `sleep 30` — ожидание, `cat README.md` — чтение файла,
 * `grep` — поиск. Строка, чей argv разбор не берёт дословно (`argvExact: false`), — просто
 * исполнение: хитро записанный сон или чтение ускользает (R8), зато ложного суда нет.
 */

export type EffectClass =
  | 'read'
  | 'search'
  | 'edit'
  | 'exec'
  | 'wait'
  | 'net'
  | 'mcp'
  | 'agent'
  | 'todo'
  | 'conversation'
  | 'other';

/**
 * Окно чтения. Оба поля `null` — не «целиком», а окно самого CLI (`CLI_DEFAULT_WINDOW`): Qwen без
 * окна режет файл по размеру, и такое чтение равно только такому же чтению того же файла.
 */
export interface ReadRange {
  /** Первая строка (с 1); отрицательное — столько строк с конца (`tail -n N`); `null` — с начала. */
  offset: number | null;
  /** Сколько строк; `null` — до конца. */
  limit: number | null;
}

/** Окно, которое выбрал сам CLI (чтение без окна, урезанное CLI по размеру). */
export const CLI_DEFAULT_WINDOW: ReadRange = Object.freeze({ offset: null, limit: null });

export interface EffectFacts {
  effectClass: EffectClass;
  /** Цель: канонический путь файла чтения/правки, иначе цель вопроса о праве. */
  target: string;
  /** Слова каждой команды строки (имя команды свёрнуто) — только у исполнения с точным argv. */
  argv: string[][] | null;
  /**
   * Окно чтения: `null` — файл целиком; `undefined` — переходник окно не сообщает, судить о
   * перечитывании и большом чтении нельзя (недосрабатывание, а не ложное).
   */
  range: ReadRange | null | undefined;
}

export interface EffectOptions {
  /** Каталог сессии (корень копии): от него разрешается относительный путь команды. */
  cwd: string | null;
  os?: OsKind;
  /**
   * Инструменты чтения вывода фонового процесса (класс `wait`): имена — факт CLI из пробы зоны M.
   */
  pollTools?: ReadonlySet<string>;
}

/** Инструменты поиска и обхода каталогов (Claude Code, Qwen Code): переходник даёт им `read`. */
const SEARCH_TOOLS = new Set([
  'Glob',
  'Grep',
  'LS',
  'glob',
  'grep_search',
  'search_file_content',
  'list_directory',
]);
const TODO_TOOLS = new Set(['TodoWrite', 'todo_write']);

/**
 * Ожидание фонового процесса — опрос (F6). Имена из пробы зоны M (`§Probe`, claude 2.1.310: `Monitor`,
 * `ScheduleWakeup`; qwen 0.24.3: `monitor`, `loop_wakeup`). `Read` файла `.output` фоновой команды
 * тоже ждёт, но по вызову не отличим от чтения — не судится (недосрабатывание).
 */
export const POLL_TOOLS: ReadonlySet<string> = new Set([
  'Monitor',
  'ScheduleWakeup',
  'monitor',
  'loop_wakeup',
]);

/** Команды цепочки после сна, которые ожидание не отменяют: показать, что вышло (`sleep 20 && ls`). */
const LOOK_COMMANDS = new Set(['echo', 'ls', 'pwd', 'dir']);

/**
 * Qwen режет чтение без окна по размеру (проба M: «Read lines 1-252 of 400 (truncated)», ~25 KB) —
 * это окно CLI, а не файл целиком: большим чтением не бывает, другое окно не покрывает.
 */
const TRUNCATING_READ_TOOLS = new Set(['read_file']);

const SEARCH_COMMANDS = new Set([
  'grep',
  'egrep',
  'fgrep',
  'rg',
  'ag',
  'find',
  'fd',
  'findstr',
  'select-string',
  'sls',
]);
const WHOLE_READ_COMMANDS = new Set(['cat', 'type', 'more']);
const CONTENT_COMMANDS = new Set(['get-content', 'gc']);
const LOOPBACK = new Set(['127.0.0.1', 'localhost', '::1']);

const isCount = (word: string | undefined): boolean => word !== undefined && /^\d+$/.test(word);
const isOption = (word: string): boolean => word.startsWith('-') && word.length > 1;

/** `sleep 30`, `sleep 1m 30s`, `sleep 0.5`. */
function isUnixSleep(args: readonly string[]): boolean {
  return args.length > 0 && args.every((a) => /^\d+(\.\d+)?[smhd]?$/.test(a));
}

/** `Start-Sleep 5`, `Start-Sleep -s 5`, `-Seconds`, `-m`, `-Milliseconds` (регистр не важен). */
function isPsSleep(args: readonly string[]): boolean {
  const flags = new Set(['-s', '-seconds', '-m', '-milliseconds']);
  const lower = args.map((a) => a.toLowerCase());
  if (lower.length === 1) return /^\d+(\.\d+)?$/.test(lower[0] as string);
  return (
    lower.length === 2 && flags.has(lower[0] as string) && /^\d+(\.\d+)?$/.test(lower[1] as string)
  );
}

/** cmd `timeout /t 30 [/nobreak]` — у POSIX `timeout 30 cmd` это обёртка, не сон. */
function isCmdTimeout(args: readonly string[]): boolean {
  const lower = args.map((a) => a.toLowerCase());
  const t = lower.indexOf('/t');
  if (t < 0 || !/^-?\d+$/.test(lower[t + 1] ?? '')) return false;
  return lower.every((a, i) => i === t || i === t + 1 || a === '/nobreak');
}

/** `ping -n 5 127.0.0.1` / `ping -c 5 localhost` — сон старых скриптов. */
function isPingSleep(args: readonly string[]): boolean {
  if (args.length !== 3) return false;
  const [flag, count, host] = args.map((a) => a.toLowerCase());
  return (flag === '-n' || flag === '-c') && isCount(count) && LOOPBACK.has(host as string);
}

function isWait(head: string, args: readonly string[]): boolean {
  if (head === 'sleep') return isUnixSleep(args) || isPsSleep(args);
  if (head === 'start-sleep') return isPsSleep(args);
  if (head === 'timeout') return isCmdTimeout(args);
  if (head === 'ping') return isPingSleep(args);
  return false;
}

interface FileRead {
  file: string;
  range: ReadRange | null;
}

/** `head [-n N | -N | --lines=N] file` → первые N строк (без числа — 10, как у head). */
function headRead(args: readonly string[]): FileRead | null {
  let limit = 10;
  const rest = [...args];
  const first = rest[0];
  if (first === '-n' && isCount(rest[1])) {
    limit = Number(rest[1]);
    rest.splice(0, 2);
  } else if (first !== undefined && /^(-n|-|--lines=)\d+$/.test(first)) {
    limit = Number(first.replace(/^(-n|-|--lines=)/, ''));
    rest.splice(0, 1);
  }
  return rest.length === 1 && !isOption(rest[0] as string)
    ? { file: rest[0] as string, range: { offset: null, limit } }
    : null;
}

/** `tail [-n N | -n +K] file` → хвост N строк (смещение с конца) или с K-й строки. */
function tailRead(args: readonly string[]): FileRead | null {
  let range: ReadRange = { offset: -10, limit: null };
  const rest = [...args];
  if (rest[0] === '-n' && rest[1] !== undefined && /^\+?\d+$/.test(rest[1])) {
    const n = rest[1];
    range = n.startsWith('+')
      ? { offset: Number(n.slice(1)), limit: null }
      : { offset: -Number(n), limit: null };
    rest.splice(0, 2);
  }
  return rest.length === 1 && !isOption(rest[0] as string)
    ? { file: rest[0] as string, range }
    : null;
}

/** `sed -n 'A,Bp' file` / `sed -n 'Ap' file` — окно строк; иной скрипт sed — исполнение. */
function sedRead(args: readonly string[]): FileRead | null {
  if (args.length !== 3 || args[0] !== '-n') return null;
  const m = /^(\d+)(?:,(\d+))?p$/.exec(args[1] as string);
  if (!m) return null;
  const from = Number(m[1]);
  const to = m[2] === undefined ? from : Number(m[2]);
  if (to < from) return null;
  return { file: args[2] as string, range: { offset: from, limit: to - from + 1 } };
}

/** `Get-Content [-Path|-LiteralPath] f [-TotalCount|-Head|-First N | -Tail|-Last N]`. */
function contentRead(args: readonly string[]): FileRead | null {
  let file: string | null = null;
  let range: ReadRange | null = null;
  for (let i = 0; i < args.length; i += 1) {
    const word = args[i] as string;
    const lower = word.toLowerCase();
    if (lower === '-path' || lower === '-literalpath') {
      if (file !== null || args[i + 1] === undefined) return null;
      file = args[(i += 1)] as string;
    } else if (['-totalcount', '-head', '-first'].includes(lower) && isCount(args[i + 1])) {
      range = { offset: null, limit: Number(args[(i += 1)]) };
    } else if (['-tail', '-last'].includes(lower) && isCount(args[i + 1])) {
      range = { offset: -Number(args[(i += 1)]), limit: null };
    } else if (isOption(word) || file !== null) {
      return null;
    } else {
      file = word;
    }
  }
  return file === null ? null : { file, range };
}

function fileRead(head: string, args: readonly string[]): FileRead | null {
  if (WHOLE_READ_COMMANDS.has(head))
    return args.length === 1 && !isOption(args[0] as string)
      ? { file: args[0] as string, range: null }
      : null;
  if (head === 'head') return headRead(args);
  if (head === 'tail') return tailRead(args);
  if (head === 'sed') return sedRead(args);
  if (CONTENT_COMMANDS.has(head)) return contentRead(args);
  return null;
}

/**
 * Канонический путь для сравнения: git-bash `/c/x` → `C:\x`, относительный — от каталога сессии,
 * формы Win32 (`\\?\`, UNC своей машины, поток, хвостовые точки) сведены `canonicalTarget`, регистр
 * свёрнут на Windows (R9). На POSIX — путь от каталога сессии как есть.
 */
export function canonicalPath(path: string, cwd: string | null, os: OsKind = currentOs()): string {
  if (path === '') return path;
  let p = path;
  if (os === 'win32') {
    const bash = /^\/([A-Za-z])(\/|$)(.*)$/s.exec(p);
    if (bash) p = `${(bash[1] as string).toUpperCase()}:\\${bash[3] ?? ''}`;
  }
  if (!isAbsolutePath(p, os) && cwd !== null) p = joinPath(os, cwd, p);
  if (os !== 'win32') return p;
  const canon = canonicalTarget(p, 'win32');
  return ('path' in canon ? canon.path : p).toLowerCase();
}

/** Разбор строки оболочки тем диалектом, которым её исполнит инструмент. */
function parseCommand(ask: PermissionAsk): ParsedScript | null {
  try {
    return ask.tool === 'PowerShell' ? parsePowerShell(ask.display) : parseBash(ask.display);
  } catch {
    // Разбор не прошёл — строка остаётся исполнением без суда (как неточный argv).
    return null;
  }
}

/**
 * Цепочка, которая ждёт: начинается сном, дальше только сны, чтения, поиск и «посмотреть» без
 * трубы (`sleep 21 && cat log.txt`). Одиночный сон CLI блокируют сами (проба M:
 * «Blocked: standalone sleep»), так что настоящее ожидание модели — именно такая цепочка.
 */
function isWaitChain(parsed: ParsedScript, argv: readonly string[][]): boolean {
  const [first, ...rest] = argv;
  if (!first || !isWait(first[0] as string, first.slice(1))) return false;
  return rest.every((words, i) => {
    const command = parsed.commands[i + 1];
    // Перенаправление сюда не доходит: с ним argv неточен (`argvExact: false`) — строка уже исполнение.
    if (!command || command.stdin !== undefined) return false;
    const [head, ...args] = words as [string, ...string[]];
    return (
      isWait(head, args) ||
      LOOK_COMMANDS.has(head) ||
      SEARCH_COMMANDS.has(head) ||
      fileRead(head, args) !== null
    );
  });
}

function execFacts(ask: PermissionAsk, opts: EffectOptions, os: OsKind): EffectFacts {
  const plain: EffectFacts = { effectClass: 'exec', target: ask.target, argv: null, range: null };
  if (ask.argvExact !== true) return plain;
  const parsed = parseCommand(ask);
  if (!parsed || parsed.unknown.length > 0 || parsed.substitutions.length > 0) return plain;
  const argv = parsed.commands.map((c) => c.words.map((w, i) => (i === 0 ? commandName(w) : w)));
  if (argv.length === 0 || argv.some((words) => words.length === 0)) return plain;
  const exec: EffectFacts = { ...plain, argv };
  if (parsed.commands.length !== 1)
    return isWaitChain(parsed, argv) ? { ...exec, effectClass: 'wait' } : exec;
  const [command] = parsed.commands;
  const [head, ...args] = argv[0] as string[];
  if (!command || head === undefined || command.stdin !== undefined) return exec;
  // Сон с выводом в никуда (`ping … > nul`) — всё ещё сон; чтение с перенаправлением — уже не чтение.
  if (isWait(head, args)) return { ...exec, effectClass: 'wait' };
  if (command.redirects.length > 0) return exec;
  const read = fileRead(head, args);
  if (read)
    return {
      ...exec,
      effectClass: 'read',
      target: canonicalPath(read.file, opts.cwd, os),
      range: read.range,
    };
  if (SEARCH_COMMANDS.has(head)) return { ...exec, effectClass: 'search', target: ask.display };
  return exec;
}

export function effectOf(ask: PermissionAsk, opts: EffectOptions): EffectFacts {
  const os = opts.os ?? currentOs();
  const plain = (effectClass: EffectClass, target = ask.target): EffectFacts => ({
    effectClass,
    target,
    argv: null,
    range: null,
  });
  if ((opts.pollTools ?? POLL_TOOLS).has(ask.tool)) return plain('wait');
  switch (ask.action) {
    case 'read':
      if (SEARCH_TOOLS.has(ask.tool)) return plain('search');
      return {
        ...plain('read', canonicalPath(ask.target, opts.cwd, os)),
        range:
          TRUNCATING_READ_TOOLS.has(ask.tool) && ask.range === null
            ? CLI_DEFAULT_WINDOW
            : ask.range,
      };
    case 'edit':
      return plain('edit', canonicalPath(ask.target, opts.cwd, os));
    case 'exec':
      return execFacts(ask, opts, os);
    case 'net':
      return plain('net');
    case 'mcp':
      return plain('mcp');
    case 'subagent':
      return plain('agent');
    case 'conversation':
      return plain(TODO_TOOLS.has(ask.tool) ? 'todo' : 'conversation');
    default:
      return plain('other');
  }
}
