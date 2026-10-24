import { readFileSync, readlinkSync, realpathSync } from 'node:fs';
import { basename, join } from 'node:path';
import {
  WINDOWS_BROWSER_IMAGES,
  browserInstallOf,
  splitWindowsCommandLine,
} from './browser-identity.ts';
import { execText, type Exec } from './peer-process.ts';

/**
 * Имя, сеанс, путь программы и командная строка процесса — факты ОС рядом с
 * деревом процессов (`peer-process.ts` отдаёт только номера и время создания).
 *
 * Зачем. Решение человека по D-n принимается, только если на том конце
 * соединения действительно браузер человека (или прокси Tailscale на этой
 * машине). Имени программы для этого мало: имя даёт кто угодно, переименовав
 * `node.exe`. Поэтому для программ браузеров читаются ещё РАЗРЕШЁННЫЙ путь
 * образа (копия вне каталога установки не подходит) и командная строка (ключи
 * автоматизации у корня браузера — отказ, `browser-identity.ts`).
 *
 * Один вызов ОС на решение: Windows — `Get-CimInstance Win32_Process` (имя,
 * номер, сеанс; путь и строка — только у программ браузеров), запасной путь —
 * `tasklist` без путей (браузеры тогда не узнаются, прокси Tailscale — да);
 * POSIX — `ps -A -o pid= -o ppid= -o sid= -o uid= -o comm=`, путь и строка —
 * Linux из `/proc/<pid>/{exe,cmdline}`, macOS вторым `ps -ww -o args=`.
 */

export interface ProcessFact {
  pid: number;
  /** Имя программы без пути: `chrome.exe`, `node`, `tailscaled`. */
  name: string;
  /** Сеанс: Windows — номер сеанса (0 — службы), POSIX — номер сеанса (`sid`). */
  session?: number;
  /** Владелец процесса (POSIX): 0 — root, у служб. */
  uid?: number;
  /** Разрешённый путь образа — только у программ браузеров. */
  path?: string;
  /** Командная строка как её видит ОС — только у программ браузеров. */
  commandLine?: string;
  /** Та же строка, разобранная на слова. */
  argv?: readonly string[];
}

export type ProcessFacts = Map<number, ProcessFact>;

/** Доступ к файлам ОС — подменяется в тестах (`/proc` и `realpath`). */
export interface FactsIo {
  readLink(path: string): string | undefined;
  readText(path: string): string | undefined;
  realpath(path: string): string | undefined;
}

const attempt =
  <T>(read: (path: string) => T) =>
  (path: string): T | undefined => {
    try {
      return read(path);
    } catch {
      return undefined;
    }
  };

export const OS_IO: FactsIo = {
  readLink: attempt((path) => readlinkSync(path)),
  readText: attempt((path) => readFileSync(path, 'utf8')),
  realpath: attempt((path) => realpathSync.native(path)),
};

/** `tasklist /fo csv /nh`: `"chrome.exe","15948","Console","1","123 456 КБ"`. */
export function parseTasklist(text: string): ProcessFacts {
  const facts: ProcessFacts = new Map();
  for (const line of text.split(/\r?\n/)) {
    const match = /^"([^"]*)","(\d+)","([^"]*)","(\d+)"/.exec(line.trim());
    if (!match) continue;
    const pid = Number(match[2]);
    // Сеанс службы называется `Services` и всегда нулевой — у Windows это
    // единственный разряд процессов без рабочего стола.
    const session = /^services$/i.test(match[3] ?? '') ? 0 : Number(match[4]);
    facts.set(pid, {
      pid,
      name: match[1] ?? '',
      ...(Number.isInteger(session) ? { session } : {}),
    });
  }
  return facts;
}

const fromBase64 = (value: string | undefined): string =>
  value ? Buffer.from(value, 'base64').toString('utf8') : '';

/**
 * Вывод `CIM_SCRIPT`: `pid<TAB>сеанс<TAB>имя<TAB>путь<TAB>строка`, текстовые поля
 * в base64 (UTF-8) — командная строка бывает с табуляцией, кавычками и не
 * в кодовой странице консоли. Путь здесь ещё НЕ разрешён.
 */
export function parseCim(text: string): ProcessFacts {
  const facts: ProcessFacts = new Map();
  for (const line of text.split(/\r?\n/)) {
    const parts = line.split('\t');
    if (parts.length < 5) continue;
    const pid = Number(parts[0]);
    const session = Number(parts[1]);
    if (!Number.isInteger(pid) || pid < 0) continue;
    const name = fromBase64(parts[2]);
    const path = fromBase64(parts[3]);
    const commandLine = fromBase64(parts[4]);
    facts.set(pid, {
      pid,
      name,
      ...(parts[1] !== '' && Number.isInteger(session) ? { session } : {}),
      ...(path ? { path } : {}),
      ...(commandLine ? { commandLine, argv: splitWindowsCommandLine(commandLine) } : {}),
    });
  }
  return facts;
}

/** Один запрос WMI на все процессы; путь и строка — только у программ браузеров. */
const CIM_SCRIPT = `$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$detail = @(${WINDOWS_BROWSER_IMAGES.map((name) => `'${name}'`).join(',')})
$utf8 = [Text.Encoding]::UTF8
function B64([string]$value) { if ($value) { [Convert]::ToBase64String($utf8.GetBytes($value)) } else { '' } }
Get-CimInstance -ClassName Win32_Process -Property ProcessId,Name,SessionId,ExecutablePath,CommandLine | ForEach-Object {
  $name = [string]$_.Name
  $path = ''; $line = ''
  if ($detail -contains $name.ToLowerInvariant()) { $path = B64 $_.ExecutablePath; $line = B64 $_.CommandLine }
  [Console]::Out.Write("$($_.ProcessId)\`t$($_.SessionId)\`t$(B64 $name)\`t$path\`t$line" + [char]10)
}`;

function powershell(): string {
  // Полный путь: PATH у фоновых процессов и под Git Bash бывает урезан.
  return join(
    process.env.SystemRoot ?? 'C:\\Windows',
    'System32',
    'WindowsPowerShell',
    'v1.0',
    'powershell.exe',
  );
}

/**
 * `ps -A -o pid= -o ppid= -o sid= -o uid= -o comm=`: числа, затем имя. macOS
 * печатает `comm` полным путём с пробелами — имя берётся последним отрезком, а
 * путь пока НЕ разрешён: его разрешает (или убирает) `readProcessFacts`.
 */
export function parsePs(text: string, withSession = true): ProcessFacts {
  const facts: ProcessFacts = new Map();
  const numbers = withSession ? 4 : 3;
  for (const line of text.split(/\n/)) {
    const parts = line.trim().split(/\s+/);
    if (parts.length < numbers + 1) continue;
    const values = parts.slice(0, numbers).map(Number);
    if (values.some((value) => !Number.isInteger(value))) continue;
    const pid = values[0] as number;
    const comm = parts.slice(numbers).join(' ');
    facts.set(pid, {
      pid,
      name: basename(comm),
      ...(withSession ? { session: values[2] as number } : {}),
      uid: values[withSession ? 3 : 2] as number,
      ...(comm.startsWith('/') ? { path: comm } : {}),
    });
  }
  return facts;
}

/** Windows: разрешить пути браузеров; не разрешился — пути нет (браузер не узнан). */
function resolveWindows(facts: ProcessFacts, io: FactsIo): ProcessFacts {
  const cache = new Map<string, string | undefined>();
  for (const fact of facts.values()) {
    if (!fact.path) continue;
    if (!cache.has(fact.path)) cache.set(fact.path, io.realpath(fact.path));
    const real = cache.get(fact.path);
    if (real) fact.path = real;
    else delete fact.path;
  }
  return facts;
}

/** Linux: `/proc/<pid>/exe` — путь, который ядро уже разрешило; строка — `cmdline`. */
function addLinuxBrowsers(facts: ProcessFacts, io: FactsIo, proc: string): void {
  for (const fact of facts.values()) {
    // Путь из `comm` у Linux не бывает, но и чужому ему здесь не место.
    delete fact.path;
    const link = io.readLink(`${proc}/${fact.pid}/exe`);
    // Обновлённый пакет оставляет работающему браузеру « (deleted)» до
    // перезапуска; место установки при этом то же.
    const path = link?.replace(/ \(deleted\)$/, '');
    if (!browserInstallOf(path, 'linux')) continue;
    const argv = (io.readText(`${proc}/${fact.pid}/cmdline`) ?? '').split('\0').filter(Boolean);
    if (argv.length === 0) continue;
    Object.assign(fact, { path, commandLine: argv.join(' '), argv });
  }
}

/** macOS: путь из `comm` разрешается, у браузеров — строка вторым `ps`. */
async function addMacBrowsers(facts: ProcessFacts, io: FactsIo, exec: Exec): Promise<void> {
  const browsers = new Map<number, string>();
  for (const fact of facts.values()) {
    // Браузер на macOS всегда работает изнутри своей связки `.app`: остальным
    // путям разрешение не нужно (сотни лишних вызовов ОС на каждое решение).
    const inBundle = fact.path?.includes('.app/Contents/');
    const real = inBundle && fact.path ? io.realpath(fact.path) : undefined;
    // Путь остаётся только у браузеров, и только разрешённый — после строки ниже.
    delete fact.path;
    if (real && browserInstallOf(real, 'darwin')) browsers.set(fact.pid, real);
  }
  if (browsers.size === 0) return;
  const text = await exec('ps', [
    '-ww',
    '-o',
    'pid=',
    '-o',
    'args=',
    '-p',
    [...browsers.keys()].join(','),
  ]);
  for (const line of (text ?? '').split(/\n/)) {
    const match = /^\s*(\d+)\s+(.+)$/.exec(line);
    const pid = Number(match?.[1]);
    const fact = facts.get(pid);
    const path = browsers.get(pid);
    if (!match || !fact || !path) continue;
    const commandLine = (match[2] as string).trim();
    // `args` склеивает слова пробелом: путь профиля с пробелом не восстановить,
    // но ключи ищутся по сырой строке, а не по словам.
    Object.assign(fact, { path, commandLine, argv: commandLine.split(/\s+/) });
  }
}

/**
 * Факты о процессах машины. `undefined` — ОС не ответила: вызывающий обязан
 * отказать, а не пропустить (решение человека — не то место, где сбой проверки
 * трактуется в пользу вызывающего).
 */
export async function readProcessFacts(
  platform: string = process.platform,
  exec: Exec = execText,
  io: FactsIo = OS_IO,
  proc = '/proc',
): Promise<ProcessFacts | undefined> {
  if (platform === 'win32') {
    const encoded = Buffer.from(CIM_SCRIPT, 'utf16le').toString('base64');
    const cim = await exec(powershell(), [
      '-NoProfile',
      '-NonInteractive',
      '-EncodedCommand',
      encoded,
    ]);
    const parsed = cim === undefined ? undefined : parseCim(cim);
    if (parsed && parsed.size > 0) return resolveWindows(parsed, io);
    // WMI не ответил — имена и сеансы без путей: прокси Tailscale узнаётся,
    // браузер нет (отказ, а не пропуск).
    const text = await exec('tasklist', ['/fo', 'csv', '/nh']);
    return text === undefined ? undefined : parseTasklist(text);
  }
  const withSid = await exec('ps', [
    '-A',
    '-o',
    'pid=',
    '-o',
    'ppid=',
    '-o',
    'sid=',
    '-o',
    'uid=',
    '-o',
    'comm=',
  ]);
  // BSD (macOS) без `sid` — те же факты без сеанса.
  const plain =
    withSid === undefined
      ? await exec('ps', ['-A', '-o', 'pid=', '-o', 'ppid=', '-o', 'uid=', '-o', 'comm='])
      : undefined;
  const facts =
    withSid !== undefined
      ? parsePs(withSid)
      : plain !== undefined
        ? parsePs(plain, false)
        : undefined;
  if (!facts) return undefined;
  if (platform === 'darwin') await addMacBrowsers(facts, io, exec);
  else addLinuxBrowsers(facts, io, proc);
  return facts;
}

/**
 * Прокси удалённого доступа на этой машине: Tailscale Serve проксирует на
 * loopback, и тот конец соединения держит служба `tailscaled`. Телефон отвечает
 * через неё — ничего другого в удалённом пути не принимается.
 */
const REMOTE_PROXY = /^(?:tailscaled?|tailscale-ipn|tailscaled?\.exe|tailscale-ipn\.exe)$/i;

export function isRemoteProxy(name: string): boolean {
  return REMOTE_PROXY.test(name.trim());
}
