import { Buffer } from 'node:buffer';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';

/**
 * Снятие процесса вместе с потомками — ОДНА реализация на сервер, посредников
 * чата (`live-relay*.mjs`) и скрипты `tools/`. Файл без типов (`.mjs`, типы в
 * `kill-tree.d.mts`): посредники и `tools/` исполняются голым Node, без
 * `--experimental-strip-types`, и `.ts` им не подключить.
 *
 * Почему не `taskkill /T`. Дерево `/T` строит по записанному PID родителя, а
 * Windows эту запись не чистит: родитель умер — у сироты так и значится его
 * номер. Номер потом достаётся нашему процессу, и сирота, запущенная задолго
 * до него, числится его «потомком». Так 2026-09-27 уборка тестового прогона
 * сняла живого сторожа стенда (запущен отвязанным, родитель давно мёртв) вместе
 * с сервером и фронтом. Настоящий потомок всегда создан ПОСЛЕ родителя, сирота
 * с чужим номером — раньше; поэтому обходим дерево сами и связь «родитель →
 * ребёнок» признаём только при таком порядке времён создания.
 *
 * Корень проверяем так же: номер процесса, который уже вышел, мог достаться
 * другому. У живого `ChildProcess` этого не бывает — libuv держит открытым его
 * дескриптор до события `exit`, а Windows не отдаёт номер, пока на процесс есть
 * дескриптор; `exitCode`/`signalCode` же выставляются раньше, чем дескриптор
 * закрывается. Для голого номера (журнал прошлой жизни сервера) вызывающий
 * передаёт `spawnedAt` — момент, когда процесс точно был нашим: создан позже —
 * значит, номер занял чужой.
 */

/** Разница эпох FILETIME (1601) и Unix (1970) в миллисекундах. */
const FILETIME_EPOCH_SHIFT_MS = 11_644_473_600_000n;

/**
 * Запас на часы: `Date.now()` и время создания процесса в ядре — одни системные
 * часы, но с разной дискретностью, и NTP может чуть сдвинуть их между записью и
 * проверкой. Без запаса свой же процесс мог бы сойти за чужой и пережить «стоп».
 */
export const REUSE_SLACK_MS = 1_000;

/** Миллисекунды Unix → тики FILETIME (100 нс от 1601-01-01 UTC). */
export function filetimeFromMs(ms) {
  return (BigInt(Math.trunc(ms)) + FILETIME_EPOCH_SHIFT_MS) * 10_000n;
}

/**
 * Чистый обход: кого снимать и в каком порядке. `table` — снимок процессов
 * (`created` в тиках FILETIME, `0n` — время неизвестно). Возвращает номера
 * листьями вперёд, корень последним, либо причину, по которой не снимаем ничего.
 * Процесс без известного времени создания в дерево не входит: доказать, что он
 * наш, нечем, а снять чужое дороже, чем оставить своё.
 */
export function planTreeKill(table, rootPid, options = {}) {
  const byPid = new Map();
  const children = new Map();
  for (const row of table) {
    byPid.set(row.pid, row);
    // Idle у Windows сам себе родитель — петля обхода.
    if (row.ppid === row.pid) continue;
    const list = children.get(row.ppid);
    if (list) list.push(row);
    else children.set(row.ppid, [row]);
  }

  const root = byPid.get(rootPid);
  if (!root) return { pids: [], skipped: 'root-absent' };
  if (!(root.created > 0n)) return { pids: [], skipped: 'root-unknown' };
  if (
    options.spawnedAt !== undefined &&
    root.created > filetimeFromMs(options.spawnedAt + REUSE_SLACK_MS)
  ) {
    return { pids: [], skipped: 'root-reused' };
  }

  const order = [];
  const seen = new Set([rootPid]);
  const visit = (parent) => {
    for (const kid of children.get(parent.pid) ?? []) {
      if (seen.has(kid.pid)) continue;
      // Создан раньше родителя — сирота, унаследовавшая его номер, а не ребёнок.
      if (!(kid.created > 0n) || kid.created < parent.created) continue;
      seen.add(kid.pid);
      visit(kid);
    }
    order.push(parent.pid);
  };
  visit(root);
  // Себя не снимаем ни при каком снимке: сервер, убивший сам себя, — хуже любой сироты.
  const self = options.selfPid ?? process.pid;
  return { pids: order.filter((pid) => pid !== self) };
}

/**
 * Снимок процессов Windows одним вызовом `NtQuerySystemInformation`
 * (SystemProcessInformation): номер, номер родителя и время создания всех
 * процессов атомарно, без открытия дескрипторов. Так же читает таблицу сам .NET
 * (`System.Diagnostics.Process`). Смещения полей — у 64- и 32-битного процесса
 * свои; WOW64 отдаёт 32-битный вид.
 */
const SNAPSHOT_SOURCE = `using System;
using System.Runtime.InteropServices;
using System.Text;
public static class AgentdeckProcessTable {
  [DllImport("ntdll.dll")] static extern int NtQuerySystemInformation(int cls, IntPtr buf, int len, out int needed);
  [DllImport("kernel32.dll", SetLastError = true)] static extern IntPtr OpenProcess(uint access, bool inherit, int pid);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool GetProcessTimes(IntPtr process, out long created, out long exited, out long kernel, out long user);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool TerminateProcess(IntPtr process, uint code);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
  // Строки плана "pid created" → строки "pid исход". Время создания сверяется на
  // ТОМ ЖЕ дескрипторе, которым процесс завершается: пока дескриптор открыт,
  // номер не достанется никому, и проверенный процесс — тот, кого снимаем.
  public static string Kill(string plan) {
    StringBuilder sb = new StringBuilder();
    foreach (string raw in plan.Split(';')) {
      string[] parts = raw.Trim().Split(' ');
      if (parts.Length != 2) continue;
      int pid = int.Parse(parts[0]);
      long expected = long.Parse(parts[1]);
      string outcome;
      IntPtr handle = OpenProcess(0x0001 | 0x1000, false, pid);
      if (handle == IntPtr.Zero) outcome = Marshal.GetLastWin32Error() == 87 ? "gone" : "denied";
      else {
        try {
          long created, exited, kernel, user;
          if (!GetProcessTimes(handle, out created, out exited, out kernel, out user)) outcome = "denied";
          // Запас в 1 мкс: запасной снимок CIM отдаёт время с точностью до микросекунды.
          else if (Math.Abs(created - expected) >= 10) outcome = "reused";
          else outcome = TerminateProcess(handle, 1) ? "killed" : "failed";
        } finally { CloseHandle(handle); }
      }
      sb.Append(pid).Append(' ').Append(outcome).Append('\\n');
    }
    return sb.ToString();
  }
  public static string Dump() {
    int size = 1 << 20;
    for (int attempt = 0; attempt < 8; attempt++) {
      IntPtr buf = Marshal.AllocHGlobal(size);
      try {
        int needed;
        int status = NtQuerySystemInformation(5, buf, size, out needed);
        if (status == unchecked((int)0xC0000004)) { size = Math.Max(size * 2, needed + (1 << 16)); continue; }
        if (status != 0) throw new Exception("NtQuerySystemInformation 0x" + status.ToString("X8"));
        bool wide = IntPtr.Size == 8;
        int pidAt = wide ? 80 : 68;
        int parentAt = wide ? 88 : 72;
        StringBuilder sb = new StringBuilder();
        long offset = 0;
        while (true) {
          IntPtr entry = new IntPtr(buf.ToInt64() + offset);
          sb.Append(Marshal.ReadIntPtr(entry, pidAt).ToInt64()).Append(' ')
            .Append(Marshal.ReadIntPtr(entry, parentAt).ToInt64()).Append(' ')
            .Append(Marshal.ReadInt64(entry, 32)).Append('\\n');
          int next = Marshal.ReadInt32(entry, 0);
          if (next == 0) break;
          offset += next;
        }
        return sb.ToString();
      } finally { Marshal.FreeHGlobal(buf); }
    }
    throw new Exception("process table keeps growing");
  }
}`;

/**
 * Скрипт PowerShell вокруг снимка. Стоимость (замер 2026-09-27, этот стенд):
 * `Get-CimInstance Win32_Process` — 730–1150 мс от запуска до ответа (сам WMI
 * ~450–500 мс), `Get-WmiObject` столько же; голый старт powershell — ~200 мс,
 * `Add-Type` + NtQuery — ~430–540 мс, а с уже собранной DLL — ~300 мс. Прежний
 * `taskkill /T` стоил ~460 мс, так что снятие не стало дороже прежнего.
 * Сборка кладётся в temp под хешем исходника (другой исходник — другой файл,
 * устаревшую не подхватим): сначала во временное имя, потом переименованием,
 * чтобы соседний вызов не загрузил недописанную. Не вышло с DLL — собираем в
 * памяти; запрещён и `Add-Type` (режим ограниченного языка) — тот же вывод
 * даёт медленный, но всегда доступный CIM.
 */
const helperScript = (action, fallback) => `$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$src = @'
${SNAPSHOT_SOURCE}
'@
$dll = $env:AGENTDECK_PROCESS_TABLE_DLL
try {
  if ($dll -and -not (Test-Path -LiteralPath $dll)) {
    $tmp = $dll + '.' + $PID + '.tmp'
    try { Add-Type -TypeDefinition $src -OutputAssembly $tmp -OutputType Library; Move-Item -LiteralPath $tmp -Destination $dll } catch { }
    Remove-Item -LiteralPath $tmp -Force -ErrorAction SilentlyContinue
  }
  if ($dll -and (Test-Path -LiteralPath $dll)) { try { Add-Type -LiteralPath $dll } catch { } }
  if (-not ('AgentdeckProcessTable' -as [type])) { Add-Type -TypeDefinition $src }
  ${action}
} catch {
${fallback}
}
`;

const SNAPSHOT_SCRIPT = helperScript(
  '[Console]::Out.Write([AgentdeckProcessTable]::Dump())',
  `  Get-CimInstance -ClassName Win32_Process -Property ProcessId,ParentProcessId,CreationDate | ForEach-Object {
    $created = 0
    if ($_.CreationDate) { $created = $_.CreationDate.ToFileTimeUtc() }
    [Console]::Out.Write("$($_.ProcessId) $($_.ParentProcessId) $created" + [char]10)
  }`,
);

/**
 * Снятие по дескриптору тем же помощником. Запасного пути нет: без C# открыть
 * дескриптор нечем — выход с кодом 3, и вызывающий снимает по номеру, как раньше.
 */
const KILL_SCRIPT = helperScript(
  '[Console]::Out.Write([AgentdeckProcessTable]::Kill($env:AGENTDECK_KILL_PLAN))',
  '  exit 3',
);

const SNAPSHOT_TIMEOUT_MS = 15_000;

let encodedScript;
let encodedKillScript;
let dllPath;

/** Собранная помощником DLL — под хешем исходника: другой исходник, другой файл. */
function helperDll() {
  dllPath ??= join(
    tmpdir(),
    `agentdeck-process-table-${createHash('sha256').update(SNAPSHOT_SOURCE).digest('hex').slice(0, 16)}.dll`,
  );
  return dllPath;
}

function powershellPath() {
  // Полный путь: PATH у фоновых процессов и под Git Bash бывает урезан.
  return join(
    process.env.SystemRoot ?? 'C:\\Windows',
    'System32',
    'WindowsPowerShell',
    'v1.0',
    'powershell.exe',
  );
}

/** Разбор вывода снимка: строки `pid ppid created`. Пустой разбор — снимка нет. */
export function parseProcessTable(text) {
  const rows = [];
  for (const line of String(text).split(/\r?\n/)) {
    const match = /^(\d+) (\d+) (\d+)$/.exec(line.trim());
    if (match)
      rows.push({ pid: Number(match[1]), ppid: Number(match[2]), created: BigInt(match[3]) });
  }
  return rows.length > 0 ? rows : undefined;
}

/**
 * Снимок процессов Windows или `undefined`, если его не получить. Синхронно:
 * снятие зовут и из обработчиков `exit`, где асинхронное уже не исполнится, и
 * вызывающие рассчитывают, что после возврата дерева нет.
 */
export function readProcessTable(run = spawnSync) {
  encodedScript ??= Buffer.from(SNAPSHOT_SCRIPT, 'utf16le').toString('base64');
  try {
    const result = run(
      powershellPath(),
      ['-NoProfile', '-NonInteractive', '-EncodedCommand', encodedScript],
      {
        encoding: 'utf8',
        windowsHide: true,
        timeout: SNAPSHOT_TIMEOUT_MS,
        env: { ...process.env, AGENTDECK_PROCESS_TABLE_DLL: helperDll() },
      },
    );
    // Таймаут или сбой — снимок неполный (запасной путь CIM пишет построчно):
    // в обрывке корня может не быть, и «root-absent» не снял бы ничего. Считаем,
    // что снимка нет, — тогда хотя бы корень снимается по старому правилу (F-205).
    if (result.error || result.status !== 0) return undefined;
    return typeof result.stdout === 'string' ? parseProcessTable(result.stdout) : undefined;
  } catch {
    return undefined;
  }
}

/** Вывод `Kill`: строки `pid исход` → карта; пустой разбор — снятия не было. */
export function parseKillOutcomes(text) {
  const outcomes = new Map();
  for (const line of String(text).split(/\r?\n/)) {
    const match = /^(\d+) (killed|gone|denied|reused|failed)$/.exec(line.trim());
    if (match) outcomes.set(Number(match[1]), match[2]);
  }
  return outcomes.size > 0 ? outcomes : undefined;
}

/**
 * Снять процессы Windows по дескриптору (F-206): `OpenProcess` → время создания
 * на ЭТОМ дескрипторе сверяется со снимком → `TerminateProcess` им же. Между
 * снимком и сигналом номер мог освободиться и достаться другому; `process.kill`
 * по номеру снял бы того, дескриптор — нет: сверка и снятие идут по одному
 * объекту процесса, и пока дескриптор открыт, номер не переиспользуется.
 * Карта `pid → исход` или `undefined`, если помощник недоступен (запрещён
 * `Add-Type`, таймаут) — тогда вызывающий снимает по номеру, как раньше.
 * Стоит второго запуска PowerShell (~300 мс с собранной DLL, замер в O1.md).
 */
export function terminateByHandle(targets, run = spawnSync) {
  const plan = targets
    .filter((target) => target.created > 0n)
    .map((target) => `${target.pid} ${target.created}`)
    .join(';');
  if (!plan) return undefined;
  encodedKillScript ??= Buffer.from(KILL_SCRIPT, 'utf16le').toString('base64');
  try {
    const result = run(
      powershellPath(),
      ['-NoProfile', '-NonInteractive', '-EncodedCommand', encodedKillScript],
      {
        encoding: 'utf8',
        windowsHide: true,
        timeout: SNAPSHOT_TIMEOUT_MS,
        env: {
          ...process.env,
          AGENTDECK_PROCESS_TABLE_DLL: helperDll(),
          AGENTDECK_KILL_PLAN: plan,
        },
      },
    );
    if (result.error || result.status !== 0) return undefined;
    return typeof result.stdout === 'string' ? parseKillOutcomes(result.stdout) : undefined;
  } catch {
    return undefined;
  }
}

/** `etime` из `ps`: `[[дд-]чч:]мм:сс` → секунды; не разобрать — `undefined`. */
function etimeSeconds(text) {
  const match = /^(?:(?:(\d+)-)?(\d+):)?(\d+):(\d+)$/.exec(text);
  if (!match) return undefined;
  const [, days, hours, minutes, seconds] = match;
  return (
    ((Number(days ?? 0) * 24 + Number(hours ?? 0)) * 60 + Number(minutes)) * 60 + Number(seconds)
  );
}

/**
 * Вывод `ps -A -o pid= -o ppid= -o etime=` → снимок той же формы, что у Windows.
 * Время создания — `now − etime` с точностью до секунды: у ребёнка оно не раньше,
 * чем у родителя, а запас `REUSE_SLACK_MS` покрывает округление корня.
 */
export function parsePosixProcessTable(text, nowMs) {
  const rows = [];
  for (const line of String(text).split(/\r?\n/)) {
    const match = /^(\d+)\s+(\d+)\s+(\S+)$/.exec(line.trim());
    const seconds = match ? etimeSeconds(match[3]) : undefined;
    if (match && seconds !== undefined) {
      rows.push({
        pid: Number(match[1]),
        ppid: Number(match[2]),
        created: filetimeFromMs(nowMs - seconds * 1000),
      });
    }
  }
  return rows.length > 0 ? rows : undefined;
}

/**
 * Снимок процессов POSIX через `ps` (есть и в Linux, и в macOS; `etime` — общий
 * для обоих формат, `etimes` в macOS нет). Нет `ps` — снимка нет.
 */
export function readPosixProcessTable(run = spawnSync) {
  try {
    const now = Date.now();
    const result = run('ps', ['-A', '-o', 'pid=', '-o', 'ppid=', '-o', 'etime='], {
      encoding: 'utf8',
      timeout: SNAPSHOT_TIMEOUT_MS,
    });
    if (result.error || result.status !== 0 || typeof result.stdout !== 'string') return undefined;
    return parsePosixProcessTable(result.stdout, now);
  } catch {
    return undefined;
  }
}

/**
 * Снять процесс с потомками. Возвращает номера, по которым ушёл сигнал.
 *
 * Windows: снимок → `planTreeKill` → `process.kill` по каждому номеру листьями
 * вперёд. `process.kill` там — тот же `TerminateProcess` с кодом выхода 1, что
 * и `taskkill /F`, но без запуска процесса на каждый номер (~0 мс против ~460).
 * Снимка нет — снимаем только корень, и то лишь когда вызывающий не просил
 * проверки времени (`spawnedAt`): проверить её нечем, а чужое не трогаем.
 *
 * POSIX: как и прежде — группа, если запуск был `detached` и группа своя
 * (`group`), иначе сам процесс. `kill(-pid)` без своей группы снёс бы сервер.
 *
 * `impl` — подмена платформы, снимка и сигнала для тестов.
 */
export function killProcessTree(pid, options = {}, impl = {}) {
  if (!Number.isInteger(pid) || pid <= 0) return [];
  const platform = impl.platform ?? process.platform;
  const send = impl.kill ?? ((target, signal) => process.kill(target, signal));
  const onKill = options.onKill ?? (() => {});
  // Процесса уже нет или он не наш по правам — снятие не должно ронять вызывающего.
  const signal = (target, name) => {
    try {
      send(target, name);
      return true;
    } catch {
      return false;
    }
  };

  if (platform === 'win32') {
    const table = (impl.readTable ?? readProcessTable)();
    const self = options.selfPid ?? process.pid;
    let pids;
    if (table) pids = planTreeKill(table, pid, options).pids;
    else pids = options.spawnedAt === undefined && pid !== self ? [pid] : [];
    for (const target of pids) onKill(target);
    // Есть снимок — снимаем по дескриптору со сверкой времени создания. Подмена
    // сигнала в тестах (`impl.kill`) без подмены снятия — по номеру, как прежде.
    const terminate = impl.terminate ?? (impl.kill ? undefined : terminateByHandle);
    if (table && pids.length > 0 && terminate) {
      const created = new Map(table.map((row) => [row.pid, row.created]));
      const outcomes = terminate(
        pids.map((target) => ({ pid: target, created: created.get(target) })),
      );
      if (outcomes) return pids.filter((target) => outcomes.get(target) === 'killed');
    }
    for (const target of pids) signal(target, 'SIGKILL');
    return pids;
  }

  if (options.group) {
    onKill(pid);
    if (signal(-pid, 'SIGTERM')) return [pid];
  }
  // Группы нет (процесс запускали не detached) — снимаем потомков по снимку
  // `ps`, листьями вперёд, и сам процесс. Раньше сигнал получал один корень, а
  // его дети (Bash-инструменты, MCP-серверы) переживали «Остановить» (F-144).
  // Подмена платформы в тестах на Windows настоящий `ps` не зовёт.
  const readTable =
    impl.readTable ?? (process.platform === 'win32' ? () => undefined : readPosixProcessTable);
  const table = readTable();
  const plan = table ? planTreeKill(table, pid, options) : undefined;
  if (plan?.skipped === 'root-reused') return [];
  const descendants = plan ? plan.pids.filter((target) => target !== pid) : [];
  for (const target of descendants) {
    onKill(target);
    signal(target, 'SIGTERM');
  }
  if (!options.group) onKill(pid);
  if (!signal(pid, 'SIGTERM')) signal(pid, 'SIGKILL');
  return [...descendants, pid];
}

/**
 * Номер дочернего процесса точно его: `exitCode` и `signalCode` оба `null`, то
 * есть событие `exit` ещё не пришло и libuv держит дескриптор. Вышел — номер мог
 * достаться другому. Поля нет вовсе (подделка, обёртка) — доказательства нет, и
 * по номеру такой объект не снимаем: тестовая подделка с `pid: 4242` иначе
 * снимала бы настоящий процесс 4242 на машине разработчика.
 */
export function childIsRunning(child) {
  return child.exitCode === null && child.signalCode === null;
}

/** Номера и группы процессов POSIX; нет `ps` — `undefined`. */
export function readPosixGroups(run = spawnSync) {
  try {
    const result = run('ps', ['-A', '-o', 'pid=', '-o', 'pgid='], {
      encoding: 'utf8',
      timeout: SNAPSHOT_TIMEOUT_MS,
    });
    if (result.error || result.status !== 0 || typeof result.stdout !== 'string') return undefined;
    const rows = [];
    for (const line of result.stdout.split(/\r?\n/)) {
      const match = /^(\d+)\s+(\d+)$/.exec(line.trim());
      if (match) rows.push({ pid: Number(match[1]), pgid: Number(match[2]) });
    }
    return rows;
  } catch {
    return undefined;
  }
}

/**
 * Группа `detached`-запуска, чей лидер уже вышел (POSIX, F-308): оболочка
 * `sh -c 'node server & exit'` уходит сразу, а сервер держит порт. Номер группы
 * не достаётся никому, пока в ней есть живые, — поэтому `kill(-pgid)` безопасен,
 * если живой процесс с номером лидера не появился (тогда номер переиспользован,
 * и группа с ним — чужая). Возвращает номера членов, по которым ушёл сигнал.
 */
export function killOrphanGroup(pgid, impl = {}) {
  if (!Number.isInteger(pgid) || pgid <= 0) return [];
  if ((impl.platform ?? process.platform) === 'win32') return [];
  const rows = (impl.readGroups ?? readPosixGroups)();
  if (!rows || rows.some((row) => row.pid === pgid)) return [];
  const members = rows.filter((row) => row.pgid === pgid).map((row) => row.pid);
  if (members.length === 0) return [];
  const send = impl.kill ?? ((target, signal) => process.kill(target, signal));
  try {
    send(-pgid, 'SIGTERM');
  } catch {
    return [];
  }
  return members;
}

/**
 * Снять дерево дочернего процесса — только пока `childIsRunning`. `child.kill()`
 * в конце обязателен: на POSIX без номера это единственное, что вообще
 * происходит, а у вышедшего — безвредный холостой вызов. Вышедший лидер своей
 * группы (`group`) — группа снимается по номеру группы (`killOrphanGroup`).
 */
export function killChildProcessTree(child, options = {}, impl = {}) {
  const killed =
    child.pid && childIsRunning(child)
      ? killProcessTree(child.pid, options, impl)
      : child.pid && options.group
        ? killOrphanGroup(child.pid, impl)
        : [];
  try {
    child.kill();
  } catch {
    // Процесс уже завершился — повторный сигнал не ошибка.
  }
  return killed;
}
