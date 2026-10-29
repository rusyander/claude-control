import { createHash } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { defaultCoreHome } from './core-home.ts';
import { powershellExe, runTool, type ToolRun } from './run-tool.ts';

/**
 * Один помощник PowerShell + C# на все факты Windows, которые Node не читает сам
 * (09: «batched CIM/snapshot per tick», «GetExtendedTcpTable via batched PowerShell»):
 * - `table` — снимок процессов одним `NtQuerySystemInformation` (pid, ppid, время
 *   создания FILETIME) — атомарно и без дескрипторов; так же читает таблицу .NET;
 * - `kill` — снятие по дескриптору: время создания сверяется на ТОМ ЖЕ дескрипторе,
 *   которым процесс снимается, — номер, отданный другому, не снимается (`reused`);
 * - `tcp` — `GetExtendedTcpTable` (IPv4 + IPv6, с владельцем) — порты и peer pid;
 * - `environ` — окружение чужих процессов того же пользователя из PEB (`NtQueryInformationProcess`
 *   → `ProcessParameters` → `Environment`, `ReadProcessMemory`) за ОДИН вызов на весь поиск:
 *   кто несёт строку `NAME=VALUE` целиком, кого прочитать не удалось и почему (`env-marker.ts`).
 *
 * Перенесено из `apps/server/src/lib/kill-tree.mjs` (снимок и снятие, замеры там же:
 * с собранной DLL ~300 мс на вызов, CIM — 730–1150 мс). DLL кладётся в `<дом ядра>/cache` под
 * хешем исходника (другой исходник — другой файл) — переиспользуемый кэш, не мусор задачи;
 * грузится только из закрытого на запись каталога (`helperDllPath`, F-18).
 * `Add-Type` запрещён (режим ограниченного языка) → снимок через CIM, снятия и TCP нет —
 * вызывающий получает `unknown`, а не пустую таблицу.
 */

const SOURCE = `using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Security.Principal;
using System.Text;
public static class AgentdeckCoreHelper {
  [DllImport("ntdll.dll")] static extern int NtQuerySystemInformation(int cls, IntPtr buf, int len, out int needed);
  [DllImport("kernel32.dll", SetLastError = true)] static extern IntPtr OpenProcess(uint access, bool inherit, int pid);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool GetProcessTimes(IntPtr process, out long created, out long exited, out long kernel, out long user);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool TerminateProcess(IntPtr process, uint code);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
  [DllImport("ntdll.dll")] static extern int NtQueryInformationProcess(IntPtr process, int cls, IntPtr info, int len, out int needed);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool ReadProcessMemory(IntPtr process, IntPtr address, IntPtr buffer, IntPtr size, out IntPtr read);
  [DllImport("kernel32.dll")] static extern bool GetExitCodeProcess(IntPtr process, out int code);
  [DllImport("kernel32.dll")] static extern IntPtr GetCurrentProcess();
  [DllImport("advapi32.dll", SetLastError = true)] static extern bool OpenProcessToken(IntPtr process, uint access, out IntPtr token);
  [DllImport("advapi32.dll", SetLastError = true)] static extern bool GetTokenInformation(IntPtr token, int cls, IntPtr info, int len, out int needed);
  [DllImport("iphlpapi.dll", SetLastError = true)] static extern uint GetExtendedTcpTable(IntPtr table, ref int size, bool order, int af, int cls, uint reserved);
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
          else if (Math.Abs(created - expected) >= 10) outcome = "reused";
          else outcome = TerminateProcess(handle, 1) ? "killed" : "failed";
        } finally { CloseHandle(handle); }
      }
      sb.Append(pid).Append(' ').Append(outcome).Append('\\n');
    }
    return sb.ToString();
  }
  // Снимок одним NtQuerySystemInformation: строки {pid, ppid, FILETIME создания}; names не null —
  // туда же, строка в строку, ImageName (UNICODE_STRING на 56: длина в байтах, Buffer на 64 x64 / 60 x86).
  static List<long[]> Snapshot() { return Snapshot(null); }
  static List<long[]> Snapshot(List<string> names) {
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
        List<long[]> rows = new List<long[]>();
        long offset = 0;
        while (true) {
          IntPtr entry = new IntPtr(buf.ToInt64() + offset);
          rows.Add(new long[] { Marshal.ReadIntPtr(entry, pidAt).ToInt64(), Marshal.ReadIntPtr(entry, parentAt).ToInt64(), Marshal.ReadInt64(entry, 32) });
          if (names != null) {
            int bytes = Marshal.ReadInt16(entry, 56) & 0xFFFF;
            IntPtr text = Marshal.ReadIntPtr(entry, wide ? 64 : 60);
            names.Add(bytes > 0 && text != IntPtr.Zero ? Marshal.PtrToStringUni(text, bytes / 2) : "");
          }
          int next = Marshal.ReadInt32(entry, 0);
          if (next == 0) break;
          offset += next;
        }
        return rows;
      } finally { Marshal.FreeHGlobal(buf); }
    }
    throw new Exception("process table keeps growing");
  }
  public static string Table() {
    StringBuilder sb = new StringBuilder();
    List<string> names = new List<string>();
    List<long[]> rows = Snapshot(names);
    for (int i = 0; i < rows.Count; i++) {
      long[] row = rows[i];
      sb.Append(row[0]).Append(' ').Append(row[1]).Append(' ').Append(row[2]);
      string name = names[i].Replace('\\r', ' ').Replace('\\n', ' ').Trim();
      if (name.Length > 0) sb.Append(' ').Append(name);
      sb.Append('\\n');
    }
    return sb.ToString();
  }
  // Строка блока (разделитель NUL) — NAME=VALUE: имя без учёта регистра (так его читает сама
  // Windows: agentdeck_tree и AGENTDECK_TREE — одна переменная, F-55), значение — точно.
  public static bool EnvironHas(string block, string wanted) {
    int eq = wanted.IndexOf('=');
    string name = wanted.Substring(0, eq + 1);
    string value = wanted.Substring(eq + 1);
    foreach (string entry in block.Split('\\0')) {
      if (entry.Length == wanted.Length && entry.StartsWith(name, StringComparison.OrdinalIgnoreCase) && string.CompareOrdinal(entry, eq + 1, value, 0, value.Length) == 0) return true;
    }
    return false;
  }
  // Восемь байт из памяти процесса (указатель или SIZE_T); IntPtr.Zero — не прочитано.
  static IntPtr ReadWord(IntPtr process, long at) {
    IntPtr buf = Marshal.AllocHGlobal(8);
    try {
      IntPtr got;
      if (!ReadProcessMemory(process, new IntPtr(at), buf, new IntPtr(8), out got) || got.ToInt64() != 8) return IntPtr.Zero;
      return Marshal.ReadIntPtr(buf);
    } finally { Marshal.FreeHGlobal(buf); }
  }
  // Блок окружения x64: PROCESS_BASIC_INFORMATION.PebBaseAddress (+8) → PEB.ProcessParameters (+0x20)
  // → RTL_USER_PROCESS_PARAMETERS.Environment (+0x80) и EnvironmentSize (+0x3F0). Процесс WOW64
  // читается по тому же родному PEB: унаследованный при создании блок лежит там. null — не прочитан.
  static string ReadEnvironment(IntPtr process) {
    IntPtr pbi = Marshal.AllocHGlobal(48);
    IntPtr peb;
    try {
      int needed;
      if (NtQueryInformationProcess(process, 0, pbi, 48, out needed) != 0) return null;
      peb = Marshal.ReadIntPtr(pbi, 8);
    } finally { Marshal.FreeHGlobal(pbi); }
    if (peb == IntPtr.Zero) return null;
    IntPtr parameters = ReadWord(process, peb.ToInt64() + 0x20);
    if (parameters == IntPtr.Zero) return null;
    IntPtr block = ReadWord(process, parameters.ToInt64() + 0x80);
    long size = ReadWord(process, parameters.ToInt64() + 0x3F0).ToInt64();
    if (block == IntPtr.Zero || size <= 0 || size > (64L << 20)) return null;
    int chars = (int)(size / 2);
    IntPtr buf = Marshal.AllocHGlobal(chars * 2);
    try {
      IntPtr got;
      if (!ReadProcessMemory(process, block, buf, new IntPtr(chars * 2), out got) || got.ToInt64() != chars * 2) return null;
      return Marshal.PtrToStringUni(buf, chars);
    } finally { Marshal.FreeHGlobal(buf); }
  }
  static IntPtr TokenInfo(IntPtr token, int cls) {
    int needed;
    GetTokenInformation(token, cls, IntPtr.Zero, 0, out needed);
    if (needed <= 0) return IntPtr.Zero;
    IntPtr buf = Marshal.AllocHGlobal(needed);
    if (GetTokenInformation(token, cls, buf, needed, out needed)) return buf;
    Marshal.FreeHGlobal(buf);
    return IntPtr.Zero;
  }
  // Маркер процесса: «self|other <RID уровня целостности>»; null — маркер закрыт для нас.
  static string TokenFacts(IntPtr process, SecurityIdentifier me) {
    IntPtr token;
    if (!OpenProcessToken(process, 0x0008, out token)) return null;
    IntPtr user = IntPtr.Zero, label = IntPtr.Zero;
    try {
      user = TokenInfo(token, 1);
      label = TokenInfo(token, 25);
      if (user == IntPtr.Zero || label == IntPtr.Zero) return null;
      string owner = new SecurityIdentifier(Marshal.ReadIntPtr(user)).Equals(me) ? "self" : "other";
      string il = new SecurityIdentifier(Marshal.ReadIntPtr(label)).Value;
      return owner + " " + il.Substring(il.LastIndexOf('-') + 1);
    } finally {
      if (user != IntPtr.Zero) Marshal.FreeHGlobal(user);
      if (label != IntPtr.Zero) Marshal.FreeHGlobal(label);
      CloseHandle(token);
    }
  }
  static bool Exited(IntPtr process) {
    int code;
    return GetExitCodeProcess(process, out code) && code != 259;
  }
  static long Created(IntPtr process, long snapshot) {
    long created, exited, kernel, user;
    return GetProcessTimes(process, out created, out exited, out kernel, out user) ? created : snapshot;
  }
  // PS_PROTECTION (класс 61); -1 — ОС не сказала.
  static int Protection(IntPtr process) {
    IntPtr buf = Marshal.AllocHGlobal(8);
    try {
      int needed;
      return NtQueryInformationProcess(process, 61, buf, 1, out needed) == 0 ? Marshal.ReadByte(buf) : -1;
    } finally { Marshal.FreeHGlobal(buf); }
  }
  // Поиск метки по окружению всех процессов одним вызовом. Строки:
  // reader <RID> · hit <pid> <created> · unread <pid> <created> (открыт на чтение, блок не прочитан)
  // · hidden <pid> <created> <RID> <защита> (свой пользователь, чтение памяти запрещено)
  // · done <прочитано> <вышли> <чужой владелец> <маркер закрыт> — последней: без неё вывод оборван.
  public static string Environ(string wanted) {
    if (IntPtr.Size != 8) throw new Exception("environ: 64-bit reader only");
    if (wanted.IndexOf('=') <= 0) throw new Exception("environ: NAME=VALUE expected");
    SecurityIdentifier me = WindowsIdentity.GetCurrent().User;
    string reader = TokenFacts(GetCurrentProcess(), me);
    if (reader == null) throw new Exception("environ: own token unreadable");
    int read = 0, gone = 0, other = 0, closed = 0;
    StringBuilder sb = new StringBuilder();
    sb.Append("reader ").Append(reader.Substring(5)).Append('\\n');
    foreach (long[] row in Snapshot()) {
      int pid = (int)row[0];
      IntPtr handle = OpenProcess(0x1000 | 0x0010, false, pid);
      if (handle != IntPtr.Zero) {
        try {
          long created = Created(handle, row[2]);
          string block = ReadEnvironment(handle);
          // Вышедший процесс в снимке не остаётся (замер 28.10: даже с открытым дескриптором),
          // так что неудача чтения — либо выход посреди чтения (вышел — не наш), либо факт «не прочитан».
          if (block == null) {
            if (Exited(handle)) gone++;
            else sb.Append("unread ").Append(pid).Append(' ').Append(created).Append('\\n');
            continue;
          }
          read++;
          if (EnvironHas(block, wanted)) sb.Append("hit ").Append(pid).Append(' ').Append(created).Append('\\n');
        } finally { CloseHandle(handle); }
        continue;
      }
      if (Marshal.GetLastWin32Error() == 87) { gone++; continue; }
      IntPtr query = OpenProcess(0x1000, false, pid);
      if (query == IntPtr.Zero) {
        if (Marshal.GetLastWin32Error() == 87) gone++; else closed++;
        continue;
      }
      try {
        if (Exited(query)) { gone++; continue; }
        string facts = TokenFacts(query, me);
        if (facts == null) { closed++; continue; }
        if (!facts.StartsWith("self ")) { other++; continue; }
        sb.Append("hidden ").Append(pid).Append(' ').Append(Created(query, row[2])).Append(' ')
          .Append(facts.Substring(5)).Append(' ').Append(Protection(query)).Append('\\n');
      } finally { CloseHandle(query); }
    }
    sb.Append("done ").Append(read).Append(' ').Append(gone).Append(' ').Append(other).Append(' ').Append(closed).Append('\\n');
    return sb.ToString();
  }
  static int Port(int raw) { return ((raw & 0xFF) << 8) | ((raw >> 8) & 0xFF); }
  static string V6(IntPtr at) {
    byte[] b = new byte[16]; Marshal.Copy(at, b, 0, 16);
    return new System.Net.IPAddress(b).ToString();
  }
  public static string Tcp() {
    StringBuilder sb = new StringBuilder();
    foreach (int af in new int[] { 2, 23 }) {
      int size = 0;
      // Замер (F-114): половина таблицы — не таблица. Без IPv6 в системе (50/87) — пропуск
      // только семейства 23; иной отказ замера — исключение, снимок целиком «не прочитан».
      uint probe = GetExtendedTcpTable(IntPtr.Zero, ref size, false, af, 5, 0);
      if (probe != 122 && probe != 0) {
        if (af == 23 && (probe == 50 || probe == 87)) continue;
        throw new Exception("GetExtendedTcpTable size " + probe);
      }
      IntPtr buf = IntPtr.Zero;
      try {
        // Таблица растёт между замером и чтением (под нагрузкой соединения рождаются
        // пачками): 122 = буфер мал — читаем заново по новому размеру, а не роняем снимок.
        uint rc = 122;
        for (int attempt = 0; attempt < 5 && rc == 122; attempt++) {
          if (buf != IntPtr.Zero) Marshal.FreeHGlobal(buf);
          size += 4096;
          buf = Marshal.AllocHGlobal(size);
          rc = GetExtendedTcpTable(buf, ref size, false, af, 5, 0);
        }
        if (rc != 0) throw new Exception("GetExtendedTcpTable " + rc);
        int count = Marshal.ReadInt32(buf, 0);
        for (int i = 0; i < count; i++) {
          if (af == 2) {
            IntPtr row = new IntPtr(buf.ToInt64() + 4 + i * 24);
            int state = Marshal.ReadInt32(row, 0);
            string la = new System.Net.IPAddress((long)(uint)Marshal.ReadInt32(row, 4)).ToString();
            int lp = Port(Marshal.ReadInt32(row, 8));
            string ra = new System.Net.IPAddress((long)(uint)Marshal.ReadInt32(row, 12)).ToString();
            int rp = Port(Marshal.ReadInt32(row, 16));
            int pid = Marshal.ReadInt32(row, 20);
            sb.Append(state).Append(' ').Append(la).Append(' ').Append(lp).Append(' ').Append(ra).Append(' ').Append(rp).Append(' ').Append(pid).Append('\\n');
          } else {
            IntPtr row = new IntPtr(buf.ToInt64() + 4 + i * 56);
            string la = V6(row);
            int lp = Port(Marshal.ReadInt32(row, 20));
            string ra = V6(new IntPtr(row.ToInt64() + 24));
            int rp = Port(Marshal.ReadInt32(row, 44));
            int state = Marshal.ReadInt32(row, 48);
            int pid = Marshal.ReadInt32(row, 52);
            sb.Append(state).Append(' ').Append(la).Append(' ').Append(lp).Append(' ').Append(ra).Append(' ').Append(rp).Append(' ').Append(pid).Append('\\n');
          }
        }
      } finally { Marshal.FreeHGlobal(buf); }
    }
    return sb.ToString();
  }
}`;

const SCRIPT = `$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$src = $env:AGENTDECK_CORE_HELPER_SRC
$dll = $env:AGENTDECK_CORE_HELPER_DLL
$op = $env:AGENTDECK_CORE_HELPER_OP
function Test-Private([string]$path, [bool]$isDir) {
  try {
    if ($isDir) { $acl = [System.IO.Directory]::GetAccessControl($path) } else { $acl = [System.IO.File]::GetAccessControl($path) }
    $sid = [System.Security.Principal.SecurityIdentifier]
    $trusted = @([System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value, 'S-1-5-18', 'S-1-5-32-544')
    if ($trusted -notcontains $acl.GetOwner($sid).Value) { return $false }
    foreach ($rule in $acl.GetAccessRules($true, $true, $sid)) {
      if ($rule.AccessControlType -ne 'Allow') { continue }
      if (([int]$rule.PropagationFlags -band 2) -ne 0) { continue }
      if ((([int64]$rule.FileSystemRights) -band 0x500D0156) -ne 0 -and $trusted -notcontains $rule.IdentityReference.Value) { return $false }
    }
    return $true
  } catch { return $false }
}
try {
  $cache = $false
  if ($dll) {
    $dir = Split-Path -Parent $dll
    $cache = (Test-Path -LiteralPath $dir) -and (Test-Private $dir $true)
  }
  if ($cache -and -not (Test-Path -LiteralPath $dll)) {
    $tmp = $dll + '.' + $PID + '.tmp'
    try { Add-Type -TypeDefinition $src -OutputAssembly $tmp -OutputType Library; Move-Item -LiteralPath $tmp -Destination $dll } catch { }
    Remove-Item -LiteralPath $tmp -Force -ErrorAction SilentlyContinue
  }
  if ($cache -and (Test-Path -LiteralPath $dll) -and (Test-Private $dll $false)) { try { Add-Type -LiteralPath $dll } catch { } }
  if (-not ('AgentdeckCoreHelper' -as [type])) { Add-Type -TypeDefinition $src }
  if ($op -eq 'table') { [Console]::Out.Write([AgentdeckCoreHelper]::Table()) }
  elseif ($op -eq 'kill') { [Console]::Out.Write([AgentdeckCoreHelper]::Kill($env:AGENTDECK_CORE_HELPER_PLAN)) }
  elseif ($op -eq 'tcp') { [Console]::Out.Write([AgentdeckCoreHelper]::Tcp()) }
  elseif ($op -eq 'environ') { [Console]::Out.Write([AgentdeckCoreHelper]::Environ($env:AGENTDECK_CORE_HELPER_PLAN)) }
  else { exit 4 }
} catch {
  if ($op -ne 'table') { exit 3 }
  Get-CimInstance -ClassName Win32_Process -Property ProcessId,ParentProcessId,CreationDate,Name | ForEach-Object {
    $created = 0
    if ($_.CreationDate) { $created = $_.CreationDate.ToFileTimeUtc() }
    $name = "$($_.Name)" -replace '[\\r\\n]', ' '
    [Console]::Out.Write("$($_.ProcessId) $($_.ParentProcessId) $created $name".TrimEnd() + [char]10)
  }
}
`;

export type HelperOp = 'table' | 'kill' | 'tcp' | 'environ';

let encoded: string | undefined;

/**
 * Окружение помощника без искомой метки: иначе её несли бы сам помощник и всё, что он порождает
 * (conhost, csc при сборке), и свип, запущенный носителем метки, находил бы собственные следы.
 * Имена переменных в Windows без учёта регистра — как и у самого блока окружения.
 */
function withoutMarker(op: HelperOp, plan: string): NodeJS.ProcessEnv {
  const env = { ...process.env };
  if (op !== 'environ') return env;
  const name = plan.slice(0, plan.indexOf('=')).toUpperCase();
  for (const key of Object.keys(env)) if (key.toUpperCase() === name) delete env[key];
  return env;
}

/**
 * Сборка помощника — в доме ядра, не в общем temp (F-18): подложенная по предсказуемому имени
 * DLL отвечала бы ядру о процессах, сокетах и снятиях. Скрипт грузит её, только если и каталог,
 * и сам файл закрыты на запись для всех, кроме пользователя, SYSTEM и администраторов (владелец —
 * из того же набора); иначе — сборка в памяти, без кэша.
 */
export function helperDllPath(env: NodeJS.ProcessEnv = process.env): string {
  const hash = createHash('sha256').update(SOURCE).digest('hex').slice(0, 16);
  return join(defaultCoreHome(env), 'cache', `agentdeck-core-helper-${hash}.dll`);
}

function ensureCacheDir(dll: string): void {
  try {
    mkdirSync(dirname(dll), { recursive: true, mode: 0o700 });
  } catch {
    // Каталога нет и не создать — скрипт увидит это и соберёт помощник в памяти.
  }
}

/**
 * Один запуск помощника; `plan` — для `kill` строки `pid created` через `;`, для `environ` —
 * искомая строка окружения `NAME=VALUE`.
 */
export function runWinHelper(op: HelperOp, plan = ''): Promise<ToolRun> {
  encoded ??= Buffer.from(SCRIPT, 'utf16le').toString('base64');
  const dll = helperDllPath();
  ensureCacheDir(dll);
  return runTool(powershellExe(), ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded], {
    timeoutMs: 20_000,
    env: {
      ...withoutMarker(op, plan),
      AGENTDECK_CORE_HELPER_DLL: dll,
      AGENTDECK_CORE_HELPER_OP: op,
      AGENTDECK_CORE_HELPER_PLAN: plan,
      // Исходник C# — переменной окружения, не в строке запуска: вместе с ним `-EncodedCommand`
      // перерос предел командной строки Windows (32 767 знаков → ENAMETOOLONG).
      AGENTDECK_CORE_HELPER_SRC: SOURCE,
    },
  });
}
