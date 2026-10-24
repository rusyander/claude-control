import { Buffer } from 'node:buffer';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';
import type { ProcessRow } from '../kill-tree.mjs';

/**
 * Есть ли в окружении процесса метка группы (RF-BGCD-09) — там, где окружение
 * чужого процесса не лежит файлом, как `/proc/<pid>/environ` на Linux.
 *
 * Зачем: сирота группы, чей родитель-оболочка прожил миллисекунды (Git Bash:
 * `cmd &` форкает копию `bash.exe` и выходит), реестру запусков не виден — номер
 * его родителя не записан нигде. Свой его делает только унаследованная метка.
 *
 * Windows — помощник C# читает блок окружения из PEB чужого процесса
 * (`NtQueryInformationProcess` → `ProcessParameters` → `Environment`) и отвечает
 * одним словом на номер: `yes|no|unknown|reused|gone`. Содержимое окружения
 * наружу не выходит никогда — в нём бывают ключи. Время создания сверяется на
 * том же дескрипторе: номер, отданный другому процессу, — `reused`, не метка.
 * 32-битный процесс под WOW64 (другая раскладка PEB) — `unknown`.
 * macOS — `ps -E` (окружение процессов своего пользователя после команды);
 * проверено только по коду: стенда macOS нет.
 */

/** Ответ помощника по одному номеру. */
export type MarkVerdict = 'yes' | 'no' | 'unknown' | 'reused' | 'gone';

const MARK_TIMEOUT_MS = 15_000;

const MARK_SOURCE = `using System;
using System.Runtime.InteropServices;
using System.Text;
public static class AgentdeckProcessEnv {
  [DllImport("kernel32.dll", SetLastError = true)] static extern IntPtr OpenProcess(uint access, bool inherit, int pid);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool GetProcessTimes(IntPtr process, out long created, out long exited, out long kernel, out long user);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool IsWow64Process(IntPtr process, out bool wow);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool ReadProcessMemory(IntPtr process, IntPtr address, byte[] buffer, IntPtr size, out IntPtr read);
  [DllImport("ntdll.dll")] static extern int NtQueryInformationProcess(IntPtr process, int cls, byte[] info, int size, out int written);
  static bool Read(IntPtr handle, long address, byte[] buffer) {
    IntPtr read;
    return ReadProcessMemory(handle, new IntPtr(address), buffer, new IntPtr(buffer.Length), out read) && read.ToInt64() == buffer.Length;
  }
  static long Pointer(IntPtr handle, long address) {
    byte[] cell = new byte[8];
    return Read(handle, address, cell) ? BitConverter.ToInt64(cell, 0) : 0;
  }
  // Environment block: size from the process parameters (Windows 10+), else page by page up to the double NUL.
  static byte[] Environment(IntPtr handle, long parameters) {
    long block = Pointer(handle, parameters + 0x80);
    if (block == 0) return null;
    long size = Pointer(handle, parameters + 0x3F0);
    if (size > 0 && size < (64L << 20)) {
      byte[] whole = new byte[size];
      if (Read(handle, block, whole)) return whole;
    }
    System.IO.MemoryStream collected = new System.IO.MemoryStream();
    byte[] page = new byte[4096];
    for (int at = 0; at < 2048; at++) {
      if (!Read(handle, block + (long)at * 4096, page)) break;
      collected.Write(page, 0, page.Length);
      for (int i = 0; i + 3 < page.Length; i += 2) {
        if (page[i] == 0 && page[i + 1] == 0 && page[i + 2] == 0 && page[i + 3] == 0) return collected.ToArray();
      }
    }
    return collected.Length > 0 ? collected.ToArray() : null;
  }
  static string Verdict(int pid, long expected, string name) {
    IntPtr handle = OpenProcess(0x0400 | 0x0010, false, pid);
    if (handle == IntPtr.Zero) handle = OpenProcess(0x1000 | 0x0010, false, pid);
    if (handle == IntPtr.Zero) return Marshal.GetLastWin32Error() == 87 ? "gone" : "unknown";
    try {
      long created, exited, kernel, user;
      if (!GetProcessTimes(handle, out created, out exited, out kernel, out user)) return "unknown";
      if (Math.Abs(created - expected) >= 10) return "reused";
      bool wow;
      if (IntPtr.Size != 8 || !IsWow64Process(handle, out wow) || wow) return "unknown";
      byte[] info = new byte[48];
      int written;
      if (NtQueryInformationProcess(handle, 0, info, info.Length, out written) != 0) return "unknown";
      long peb = BitConverter.ToInt64(info, 8);
      long parameters = peb == 0 ? 0 : Pointer(handle, peb + 0x20);
      byte[] env = parameters == 0 ? null : Environment(handle, parameters);
      if (env == null) return "unknown";
      string prefix = name + "=";
      foreach (string pair in Encoding.Unicode.GetString(env).Split((char)0)) {
        if (pair.Length > prefix.Length && pair.StartsWith(prefix, StringComparison.OrdinalIgnoreCase)) return "yes";
      }
      return "no";
    } finally { CloseHandle(handle); }
  }
  // Plan "pid created" joined by ";" -> lines "pid verdict". Environment content is never printed.
  public static string Marks(string plan, string name) {
    StringBuilder sb = new StringBuilder();
    foreach (string raw in plan.Split(';')) {
      string[] parts = raw.Trim().Split(' ');
      if (parts.Length != 2) continue;
      int pid = int.Parse(parts[0]);
      string verdict;
      try { verdict = Verdict(pid, long.Parse(parts[1]), name); } catch { verdict = "unknown"; }
      sb.Append(pid).Append(' ').Append(verdict).Append('\\n');
    }
    return sb.ToString();
  }
}`;

/**
 * Сборка — как у снимка процессов (`kill-tree.mjs`): DLL в temp под хешем
 * исходника, во временное имя и переименованием; не вышло — в памяти; запрещён
 * `Add-Type` — выход 3, метки нет.
 */
const MARK_SCRIPT = `$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$src = @'
${MARK_SOURCE}
'@
$dll = $env:AGENTDECK_PROCESS_ENV_DLL
try {
  if ($dll -and -not (Test-Path -LiteralPath $dll)) {
    $tmp = $dll + '.' + $PID + '.tmp'
    try { Add-Type -TypeDefinition $src -OutputAssembly $tmp -OutputType Library; Move-Item -LiteralPath $tmp -Destination $dll } catch { }
    Remove-Item -LiteralPath $tmp -Force -ErrorAction SilentlyContinue
  }
  if ($dll -and (Test-Path -LiteralPath $dll)) { try { Add-Type -LiteralPath $dll } catch { } }
  if (-not ('AgentdeckProcessEnv' -as [type])) { Add-Type -TypeDefinition $src }
  [Console]::Out.Write([AgentdeckProcessEnv]::Marks($env:AGENTDECK_MARK_PLAN, $env:AGENTDECK_MARK_NAME))
} catch {
  exit 3
}
`;

let encoded: string | undefined;
let dllPath: string | undefined;

function markDll(): string {
  dllPath ??= join(
    tmpdir(),
    `agentdeck-process-env-${createHash('sha256').update(MARK_SOURCE).digest('hex').slice(0, 16)}.dll`,
  );
  return dllPath;
}

function powershellPath(): string {
  // Полный путь: PATH у фоновых процессов и под Git Bash бывает урезан.
  return join(
    process.env.SystemRoot ?? 'C:\\Windows',
    'System32',
    'WindowsPowerShell',
    'v1.0',
    'powershell.exe',
  );
}

/** Вывод помощника `pid ответ` → карта; пустой разбор — ответа нет. */
export function parseMarkVerdicts(text: string): Map<number, MarkVerdict> | undefined {
  const verdicts = new Map<number, MarkVerdict>();
  for (const line of text.split(/\r?\n/)) {
    const match = /^(\d+) (yes|no|unknown|reused|gone)$/.exec(line.trim());
    if (match) verdicts.set(Number(match[1]), match[2] as MarkVerdict);
  }
  return verdicts.size > 0 ? verdicts : undefined;
}

/** Ответы помощника по номерам; `undefined` — помощник не отработал. */
export function readWindowsMarkVerdicts(
  rows: readonly ProcessRow[],
  name: string,
): Promise<Map<number, MarkVerdict> | undefined> {
  const plan = rows
    .filter((row) => row.created > 0n)
    .map((row) => `${row.pid} ${row.created}`)
    .join(';');
  if (!plan || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) return Promise.resolve(undefined);
  encoded ??= Buffer.from(MARK_SCRIPT, 'utf16le').toString('base64');
  return new Promise((done) => {
    try {
      execFile(
        powershellPath(),
        ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded ?? ''],
        {
          encoding: 'utf8',
          windowsHide: true,
          timeout: MARK_TIMEOUT_MS,
          env: {
            ...process.env,
            AGENTDECK_PROCESS_ENV_DLL: markDll(),
            AGENTDECK_MARK_PLAN: plan,
            AGENTDECK_MARK_NAME: name,
          },
        },
        (error, stdout) => done(error ? undefined : parseMarkVerdicts(stdout)),
      );
    } catch {
      done(undefined);
    }
  });
}

/**
 * Вывод `ps -E -ww -o pid= -o command=` → у каких номеров метка. Окружение стоит
 * после аргументов через пробел; `NAME=` в самих аргументах тоже засчитается —
 * кандидаты и так несут путь копии, и ложная метка там стоит не больше прежнего
 * правила возраста.
 */
export function parsePsEnvMarks(text: string, name: string): Map<number, boolean> {
  const marks = new Map<number, boolean>();
  const pattern = new RegExp(`(?:^|\\s)${name}=\\S`);
  for (const line of text.split(/\r?\n/)) {
    const match = /^\s*(\d+)\s(.*)$/.exec(line);
    if (match) marks.set(Number(match[1]), pattern.test(match[2] ?? ''));
  }
  return marks;
}

function readDarwinMarks(
  rows: readonly ProcessRow[],
  name: string,
): Promise<Map<number, boolean> | undefined> {
  if (rows.length === 0 || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
    return Promise.resolve(undefined);
  }
  return new Promise((done) => {
    try {
      execFile(
        'ps',
        ['-E', '-ww', '-o', 'pid=', '-o', 'command=', '-p', rows.map((row) => row.pid).join(',')],
        { encoding: 'utf8', timeout: MARK_TIMEOUT_MS, maxBuffer: 64 * 1024 * 1024 },
        // `ps -p` выходит с 1, когда часть номеров уже вышла, — вывод по живым всё равно есть.
        (_error, stdout) => done(stdout ? parsePsEnvMarks(stdout, name) : undefined),
      );
    } catch {
      done(undefined);
    }
  });
}

/**
 * Метка по номеру для кандидатов; `undefined` — на этой ОС не прочесть. Linux
 * здесь — для суда над погашением (`group-process-owner.ts`); добор после паузы
 * читает `/proc` сам (`path-sweep.ts`).
 */
export async function readMarks(
  rows: readonly ProcessRow[],
  name: string,
  platform: string = process.platform,
): Promise<Map<number, boolean> | undefined> {
  if (platform === 'win32') {
    const verdicts = await readWindowsMarkVerdicts(rows, name);
    if (!verdicts) return undefined;
    return new Map([...verdicts].map(([pid, verdict]) => [pid, verdict === 'yes']));
  }
  if (platform === 'darwin') return readDarwinMarks(rows, name);
  if (platform === 'linux') return new Map(rows.map((row) => [row.pid, linuxMark(row.pid, name)]));
  return undefined;
}

/** Linux: окружение лежит файлом `/proc/<pid>/environ` (`A=1\0B=2`). */
function linuxMark(pid: number, name: string): boolean {
  try {
    return readFileSync(`/proc/${pid}/environ`, 'utf8')
      .split('\0')
      .some((pair) => pair.startsWith(`${name}=`) && pair.length > name.length + 1);
  } catch {
    return false;
  }
}
