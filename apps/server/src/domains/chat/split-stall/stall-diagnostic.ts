import { execFile } from 'node:child_process';
import { mkdir, readdir, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/**
 * Что держало вызов повисшей группы — до того, как сторож снимет процесс.
 *
 * 19.10 две группы ждали итога Bash 4 ч и 7,7 ч, хотя команда одной из них свою
 * работу закончила (строка «завершилась с кодом 0» в её журнале). Снятие стирает
 * улики: после него не узнать, кто держал вывод открытым — внук, переживший
 * команду (служба esbuild, рабочий vitest, стенд), или сама команда. Поэтому
 * перед снятием — снимок дерева процессов под CLI в файл, путь к нему — в заметку
 * родителю. Плюс процессы ВНЕ дерева, чья командная строка называет копию группы:
 * на Windows осиротевший внук сохраняет номер мёртвого родителя и из дерева
 * выпадает, а держать канал продолжает.
 */

export interface StallProcess {
  pid: number;
  ppid: number;
  name: string;
  /** Время старта ISO (UTC); неизвестно — нет. */
  startedAt?: string;
  command?: string;
}

interface WindowsRow {
  ProcessId: number;
  ParentProcessId?: number;
  Name?: string;
  Started?: string | null;
  CommandLine?: string | null;
}

/**
 * Вывод `Get-CimInstance Win32_Process` → строки. `Started` — заранее в ISO
 * (`ConvertTo-Json` Windows PowerShell 5.1 отдаёт даты как `/Date(…)/`, это тоже
 * понимаем). Один процесс — объект, не массив.
 */
export function parseWindowsProcesses(stdout: string): StallProcess[] {
  const raw = (stdout.charCodeAt(0) === 0xfeff ? stdout.slice(1) : stdout).trim();
  if (!raw) return [];
  const parsed = JSON.parse(raw) as WindowsRow[] | WindowsRow;
  return (Array.isArray(parsed) ? parsed : [parsed]).flatMap((row) => {
    if (typeof row.ProcessId !== 'number') return [];
    const epoch = /\/Date\((\d+)\)\//.exec(row.Started ?? '');
    const startedAt = epoch?.[1] ? new Date(Number(epoch[1])).toISOString() : row.Started;
    return [
      {
        pid: row.ProcessId,
        ppid: row.ParentProcessId ?? 0,
        name: row.Name ?? '',
        ...(startedAt ? { startedAt } : {}),
        ...(row.CommandLine ? { command: row.CommandLine } : {}),
      },
    ];
  });
}

/** `[[dd-]hh:]mm:ss` → секунды; не разобрали — `undefined`. */
function etimeSeconds(text: string): number | undefined {
  const match = /^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+)$/.exec(text);
  if (!match) return undefined;
  const [, days, hours, minutes, seconds] = match;
  return (
    ((Number(days ?? 0) * 24 + Number(hours ?? 0)) * 60 + Number(minutes)) * 60 + Number(seconds)
  );
}

/**
 * Вывод `ps -A -o pid= -o ppid= -o etime= -o args=` → строки. Имя — последний
 * сегмент первого слова команды: `comm` в macOS и Linux режется по-разному.
 */
export function parsePosixProcesses(stdout: string, now = Date.now()): StallProcess[] {
  return stdout.split(/\r?\n/).flatMap((line) => {
    const match = /^\s*(\d+)\s+(\d+)\s+(\S+)\s*(.*)$/.exec(line);
    if (!match) return [];
    const seconds = etimeSeconds(match[3] ?? '');
    const command = (match[4] ?? '').trim();
    return [
      {
        pid: Number(match[1]),
        ppid: Number(match[2]),
        name: (command.split(/\s+/)[0] ?? '').split('/').pop() ?? '',
        ...(seconds !== undefined
          ? { startedAt: new Date(now - seconds * 1000).toISOString() }
          : {}),
        ...(command ? { command } : {}),
      },
    ];
  });
}

/** Полный список процессов машины; `undefined` — не получен (таймаут, отказ). */
export async function readStallProcesses(
  platform: NodeJS.Platform = process.platform,
): Promise<StallProcess[] | undefined> {
  try {
    if (platform === 'win32') {
      const { stdout } = await execFileAsync(
        'powershell.exe',
        [
          '-NoProfile',
          '-NonInteractive',
          '-Command',
          "Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name,@{n='Started';e={if ($_.CreationDate) { $_.CreationDate.ToUniversalTime().ToString('o') }}},CommandLine | ConvertTo-Json -Compress",
        ],
        { windowsHide: true, timeout: 30_000, maxBuffer: 64 * 1024 * 1024 },
      );
      return parseWindowsProcesses(stdout);
    }
    const { stdout } = await execFileAsync(
      'ps',
      ['-A', '-o', 'pid=', '-o', 'ppid=', '-o', 'etime=', '-o', 'args='],
      { timeout: 15_000, maxBuffer: 64 * 1024 * 1024 },
    );
    return parsePosixProcesses(stdout);
  } catch {
    return undefined;
  }
}

export interface TreeEntry {
  process: StallProcess;
  depth: number;
}

/**
 * Дерево под корнями, корни первыми, дети по времени старта. Номер, которого нет
 * в списке, — корень без строки (процесс уже ушёл): его дети всё равно ищутся.
 */
export function processTree(rows: readonly StallProcess[], roots: readonly number[]): TreeEntry[] {
  const children = new Map<number, StallProcess[]>();
  for (const row of rows) {
    if (row.pid === row.ppid) continue;
    const list = children.get(row.ppid) ?? [];
    list.push(row);
    children.set(row.ppid, list);
  }
  const byPid = new Map(rows.map((row) => [row.pid, row]));
  const seen = new Set<number>();
  const out: TreeEntry[] = [];
  const walk = (pid: number, depth: number): void => {
    if (seen.has(pid)) return;
    seen.add(pid);
    const row = byPid.get(pid);
    if (row) out.push({ process: row, depth });
    const kids = [...(children.get(pid) ?? [])].sort((a, b) =>
      (a.startedAt ?? '').localeCompare(b.startedAt ?? ''),
    );
    for (const kid of kids) walk(kid.pid, row ? depth + 1 : depth);
  };
  // Корень, который сам лежит под другим корнем (посредник → оболочка → CLI), обходится
  // там, где он есть в дереве, а не вторым корнем.
  const rootSet = new Set(roots);
  const top = roots.filter((pid) => !rootSet.has(byPid.get(pid)?.ppid ?? -1));
  for (const pid of top.length > 0 ? top : roots) walk(pid, 0);
  return out;
}

/** Путь Windows — с буквой диска или UNC: только там регистр не различает папки. */
const WINDOWS_PATH = /^[A-Za-z]:([\\/]|$)|^\\\\/;

/** Прямые черты; регистр складывается только у копии Windows — на Linux `App` и `app` разные копии. */
const comparable = (text: string, fold: boolean): string => {
  const slashed = text.replace(/\\/g, '/');
  return fold ? slashed.toLowerCase() : slashed;
};

/** Процессы вне дерева, чья командная строка называет копию группы. */
export function straysOf(
  rows: readonly StallProcess[],
  tree: readonly TreeEntry[],
  copyPath: string | undefined,
  selfPid = process.pid,
): StallProcess[] {
  if (!copyPath) return [];
  const fold = WINDOWS_PATH.test(copyPath);
  const needle = comparable(copyPath, fold).replace(/\/+$/, '');
  if (needle.length < 4) return [];
  const inTree = new Set(tree.map((entry) => entry.process.pid));
  return rows.filter(
    (row) =>
      !inTree.has(row.pid) &&
      row.pid !== selfPid &&
      row.command !== undefined &&
      comparable(row.command, fold).includes(needle),
  );
}

export interface StallInfo {
  key: string;
  group: string;
  chatIds: readonly string[];
  silentMs: number;
  copyPath?: string | undefined;
  roots: readonly number[];
}

const line = (row: StallProcess, indent = ''): string =>
  `${indent}${row.pid} (ppid ${row.ppid}) ${row.name || '?'}  started ${row.startedAt ?? '?'}\n${indent}    ${row.command ?? '(no command line)'}`;

/** Текст журнала: кто, сколько молчал, дерево с отступами, процессы копии вне дерева. */
export function formatStallLog(
  info: StallInfo,
  rows: readonly StallProcess[] | undefined,
  at: Date,
): string {
  const head = [
    `split stall diagnostic ${at.toISOString()}`,
    `group: ${info.group} (${info.key})`,
    `silent: ${Math.round(info.silentMs / 60_000)} min`,
    `chats: ${info.chatIds.join(', ')}`,
    `copy: ${info.copyPath ?? '-'}`,
    `cli roots: ${info.roots.length > 0 ? info.roots.join(', ') : '- (no live run in the panel)'}`,
    '',
  ];
  if (!rows) return [...head, 'process list: NOT READ (timeout or refusal)', ''].join('\n');
  const tree = processTree(rows, info.roots);
  const strays = straysOf(rows, tree, info.copyPath);
  return [
    ...head,
    `process tree under the CLI (${tree.length}):`,
    ...(tree.length > 0
      ? tree.map((entry) => line(entry.process, '  '.repeat(entry.depth + 1)))
      : ['  (empty — the CLI process is gone)']),
    '',
    `outside the tree, naming the copy (${strays.length}):`,
    ...(strays.length > 0 ? strays.map((row) => line(row, '  ')) : ['  (none)']),
    '',
  ].join('\n');
}

/** Сколько журналов хранить: старше — удаляются при записи нового. */
export const STALL_LOG_KEEP = 50;

/**
 * Записать журнал повисшей группы в `dir`; путь файла — ответ. Чтение списка
 * процессов асинхронное (CIM ~1 с): сторож не держит цикл событий сервера.
 */
export async function writeStallLog(
  dir: string,
  info: StallInfo,
  read: () => Promise<StallProcess[] | undefined> = () => readStallProcesses(),
  now: () => Date = () => new Date(),
): Promise<string> {
  const rows = await read();
  const at = now();
  await mkdir(dir, { recursive: true });
  const safeKey = info.key.replace(/[^\w.-]+/g, '_').slice(0, 80);
  const file = join(dir, `stall-${at.toISOString().replace(/[:.]/g, '-')}-${safeKey}.log`);
  await writeFile(file, formatStallLog(info, rows, at), 'utf8');
  const logs = (await readdir(dir)).filter((name) => /^stall-.*\.log$/.test(name)).sort();
  for (const name of logs.slice(0, Math.max(0, logs.length - STALL_LOG_KEEP))) {
    await unlink(join(dir, name)).catch(() => undefined);
  }
  return file;
}
