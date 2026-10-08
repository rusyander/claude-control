import { execFile } from 'node:child_process';
import { statSync } from 'node:fs';
import { basename } from 'node:path';
import { promisify } from 'node:util';
import type { SessionStopResult, SessionWhere } from '@agentdeck/contracts';
import type { SessionStopBody } from '@agentdeck/contracts/request-bodies';
import { filetimeFromMs, type ProcessRow } from '../../lib/kill-tree.mjs';
import { killPidTree } from '../../lib/process-tree/process-tree.ts';
import { isClaudeAgentCommand } from './runtime.ts';

const execFileAsync = promisify(execFile);

/**
 * «Где идёт сессия» и «Остановить» для вкладки «Сессии» аналитики.
 *
 * Сессия — это транскрипт; процесс, который её ведёт, надо найти. Надёжный
 * признак один: номер сессии в командной строке CLI (`--resume <id>`,
 * `--session-id <id>`) — так запускают и расширение редактора, и сама панель.
 * `claude`, запущенный в терминале без номера, не сообщает, какую сессию ведёт;
 * такую сессию честно называем неопознанной и не угадываем: снять чужой процесс
 * дороже, чем не снять свой.
 */

/** Столько после последней записи транскрипт считается пишущимся — как в сканере. */
export const WRITING_WINDOW_MS = 10 * 60 * 1000;

/**
 * Допуск при сверке времени создания: на Windows оно приходит в миллисекундах,
 * `ps` отдаёт возраст в секундах. Больше расхождение — под номером другой процесс.
 */
export const START_TOLERANCE_MS = 2_000;

/** Процесс CLI: номер, родитель, время создания и командная строка. */
export interface CliProcess {
  pid: number;
  ppid: number;
  startedAtMs: number;
  commandLine: string;
}

/** Прогон чата панели — ровно поля `ChatRunRegistry.active()`, нужные здесь. */
export interface PanelRunView {
  chatId: string;
  sessionId?: string;
  status: 'running' | 'done';
  detached?: true;
}

const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const SESSION_FLAG = new RegExp(
  `(?:^|[\\s"'])(?:--resume|--session-id|-r)(?:=|\\s+)["']?(${UUID})`,
  'gi',
);

/** Номера сессий, названные в командной строке CLI. */
export function sessionIdsInCommand(commandLine: string): string[] {
  return [...commandLine.matchAll(SESSION_FLAG)].map((match) => (match[1] ?? '').toLowerCase());
}

/** Редакторы, чьи расширения носят CLI у себя в каталоге. */
const EDITORS: Array<[RegExp, string]> = [
  [/[\\/]\.vscode-oss[\\/]extensions[\\/]/i, 'VSCodium'],
  [/[\\/]\.vscode(-insiders)?[\\/]extensions[\\/]/i, 'VS Code'],
  [/[\\/]\.cursor[\\/]extensions[\\/]/i, 'Cursor'],
  [/[\\/]\.windsurf[\\/]extensions[\\/]/i, 'Windsurf'],
];

export function hostOf(commandLine: string): { host: 'editor' | 'terminal'; editor?: string } {
  const found = EDITORS.find(([pattern]) => pattern.test(commandLine));
  return found ? { host: 'editor', editor: found[1] } : { host: 'terminal' };
}

/** Командная строка для человека: путь к исполняемому — одним именем, длина — в меру. */
export function shortCommand(commandLine: string, max = 160): string {
  const trimmed = commandLine.trim().replace(/\s+/g, ' ');
  const quoted = /^"([^"]+)"\s*(.*)$/.exec(trimmed);
  const [exe, rest] = quoted
    ? [quoted[1] ?? '', quoted[2] ?? '']
    : [trimmed.split(' ')[0] ?? '', trimmed.split(' ').slice(1).join(' ')];
  const text = `${basename(exe.replace(/\\/g, '/'))} ${rest}`.trim();
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/**
 * Предки процесса по снимку: родитель признаётся, только если создан не позже
 * ребёнка — у сироты записан номер умершего родителя, и номер мог достаться
 * кому угодно (та же логика, что у `planTreeKill`).
 */
export function ancestorsOf(table: readonly ProcessRow[], pid: number): Set<number> {
  const byPid = new Map(table.map((row) => [row.pid, row]));
  const found = new Set<number>();
  let current = byPid.get(pid);
  while (current && current.ppid !== current.pid && !found.has(current.ppid)) {
    const parent = byPid.get(current.ppid);
    if (!parent || !(parent.created > 0n) || parent.created > current.created) break;
    found.add(parent.pid);
    current = parent;
  }
  return found;
}

/** Где идёт сессия — по прогонам панели, процессам CLI и свежести транскрипта. */
export function locateSession(
  sessionId: string,
  input: {
    panelRuns: readonly PanelRunView[];
    processes: readonly CliProcess[];
    /** `undefined` — предков узнать не удалось; стоп тогда откажет сам. */
    panelAncestors: ReadonlySet<number> | undefined;
    isWriting: boolean;
  },
): SessionWhere {
  const id = sessionId.toLowerCase();
  const run = input.panelRuns.find(
    (item) =>
      item.status === 'running' &&
      (item.sessionId?.toLowerCase() === id || item.chatId.toLowerCase() === id),
  );
  if (run) {
    return { kind: 'panel', chatId: run.chatId, ...(run.detached ? { detached: true } : {}) };
  }

  // Несколько процессов с одним номером (двойной `--resume`) — берём самый
  // свежий: старший, скорее всего, уже ничего не пишет.
  const found = input.processes
    .filter((item) => sessionIdsInCommand(item.commandLine).includes(id))
    .sort((a, b) => b.startedAtMs - a.startedAtMs)[0];
  if (found) {
    return {
      kind: 'process',
      pid: found.pid,
      startedAt: new Date(found.startedAtMs).toISOString(),
      ...hostOf(found.commandLine),
      command: shortCommand(found.commandLine),
      ownsPanel: input.panelAncestors?.has(found.pid) ?? false,
    };
  }

  return input.isWriting ? { kind: 'unidentified' } : { kind: 'finished' };
}

/** Пишется ли транскрипт сейчас: менялся за окно сканера. */
export function transcriptIsWriting(path: string | undefined, now = Date.now()): boolean {
  if (!path) return false;
  try {
    return now - statSync(path).mtimeMs < WRITING_WINDOW_MS;
  } catch {
    return false;
  }
}

interface WindowsCliRow {
  ProcessId: number;
  ParentProcessId?: number;
  CommandLine?: string;
  CreationDate?: string;
}

/** Разбор вывода CIM: один процесс PowerShell отдаёт объектом, несколько — массивом. */
export function parseWindowsCli(stdout: string): CliProcess[] {
  const raw = stdout.replace(/^\uFEFF/, '').trim();
  if (!raw) return [];
  const parsed = JSON.parse(raw) as WindowsCliRow[] | WindowsCliRow;
  return (Array.isArray(parsed) ? parsed : [parsed]).flatMap((row) => {
    const commandLine = row.CommandLine ?? '';
    const epoch = /\/Date\((\d+)\)\//.exec(row.CreationDate ?? '');
    const startedAtMs = epoch?.[1] ? Number(epoch[1]) : Date.parse(row.CreationDate ?? '');
    if (!isClaudeAgentCommand(commandLine) || !Number.isFinite(startedAtMs)) return [];
    return [{ pid: row.ProcessId, ppid: row.ParentProcessId ?? 0, startedAtMs, commandLine }];
  });
}

/**
 * Возраст из `etime` в секундах: `[[дд-]чч:]мм:сс`. Не `etimes` — его знает только
 * procps (Linux); BSD `ps` на macOS отвечает «keyword not found», и список был пуст.
 */
export function parseEtime(text: string): number | undefined {
  const match = /^(?:(?:(\d+)-)?(\d+):)?(\d+):(\d+)$/.exec(text.trim());
  if (!match) return undefined;
  const [, days, hours, minutes, seconds] = match;
  return (
    Number(days ?? 0) * 86_400 + Number(hours ?? 0) * 3_600 + Number(minutes) * 60 + Number(seconds)
  );
}

/** Разбор `ps -eo pid=,ppid=,etime=,args=`: возраст → время создания. */
export function parseUnixCli(stdout: string, now = Date.now()): CliProcess[] {
  return stdout.split('\n').flatMap((line) => {
    const match = /^\s*(\d+)\s+(\d+)\s+([\d:-]+)\s+(.+)$/.exec(line);
    const age = match ? parseEtime(match[3] ?? '') : undefined;
    if (!match || age === undefined || !isClaudeAgentCommand(match[4] ?? '')) return [];
    return [
      {
        pid: Number(match[1]),
        ppid: Number(match[2]),
        startedAtMs: now - age * 1000,
        commandLine: match[4] ?? '',
      },
    ];
  });
}

/**
 * Процессы CLI на машине — без кэша: стоп обязан видеть настоящее.
 * `undefined` — список НЕ получен (таймаут CIM/`ps`, отказ системы, нечитаемый
 * ответ). Это не «процессов нет»: на отказе, прочитанном пустым списком, живой
 * процесс сессии назывался «уже не было» (F-145b). Что сказать человеку, когда
 * проверить нечем, решает каждый потребитель сам.
 */
export async function listCliProcesses(): Promise<CliProcess[] | undefined> {
  try {
    if (process.platform === 'win32') {
      const { stdout } = await execFileAsync(
        'powershell.exe',
        [
          '-NoProfile',
          '-Command',
          "Get-CimInstance Win32_Process -Filter \"Name='node.exe' or Name='claude.exe'\" | Select-Object ProcessId,ParentProcessId,CommandLine,CreationDate | ConvertTo-Json -Compress",
        ],
        { windowsHide: true, timeout: 15_000, maxBuffer: 16 * 1024 * 1024 },
      );
      return parseWindowsCli(stdout);
    }
    const { stdout } = await execFileAsync('ps', ['-eo', 'pid=,ppid=,etime=,args='], {
      timeout: 10_000,
      maxBuffer: 16 * 1024 * 1024,
    });
    return parseUnixCli(stdout);
  } catch {
    return undefined;
  }
}

/** Разбор всех процессов из CIM (номер, родитель, время создания) в строки снимка. */
export function parseWindowsTable(stdout: string): ProcessRow[] {
  const raw = stdout.replace(/^\uFEFF/, '').trim();
  if (!raw) return [];
  const parsed = JSON.parse(raw) as WindowsCliRow[] | WindowsCliRow;
  return (Array.isArray(parsed) ? parsed : [parsed]).flatMap((row) => {
    const epoch = /\/Date\((\d+)\)\//.exec(row.CreationDate ?? '');
    if (!epoch?.[1]) return [];
    return [
      {
        pid: row.ProcessId,
        ppid: row.ParentProcessId ?? 0,
        created: filetimeFromMs(Number(epoch[1])),
      },
    ];
  });
}

/**
 * Предки сервера панели. На Windows — по всем процессам CIM с временем создания
 * (асинхронно: синхронный снимок `readProcessTable` держал бы сервер полсекунды
 * на каждое открытие окна); на прочих ОС — по родителям из `ps`.
 * `undefined` — снимка нет (таймаут, отказ системы): пустое множество читалось
 * бы «панель не задета», и стоп снимал бы номер без проверки (V-fix-D).
 */
export async function panelAncestors(selfPid = process.pid): Promise<Set<number> | undefined> {
  if (process.platform === 'win32') {
    try {
      const { stdout } = await execFileAsync(
        'powershell.exe',
        [
          '-NoProfile',
          '-Command',
          'Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,CreationDate | ConvertTo-Json -Compress',
        ],
        { windowsHide: true, timeout: 15_000, maxBuffer: 16 * 1024 * 1024 },
      );
      return ancestorsOf(parseWindowsTable(stdout), selfPid);
    } catch {
      return undefined;
    }
  }
  try {
    const { stdout } = await execFileAsync('ps', ['-eo', 'pid=,ppid='], { timeout: 10_000 });
    const table: ProcessRow[] = stdout.split('\n').flatMap((line) => {
      const match = /^\s*(\d+)\s+(\d+)/.exec(line);
      return match ? [{ pid: Number(match[1]), ppid: Number(match[2]), created: 1n }] : [];
    });
    return ancestorsOf(table, selfPid);
  } catch {
    return undefined;
  }
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export interface StopDeps {
  /** `undefined` — список не получен (см. `listCliProcesses`). */
  list: () => Promise<CliProcess[] | undefined>;
  /** `undefined` — предков узнать не удалось. */
  ancestors: () => Promise<Set<number> | undefined>;
  kill: (pid: number, spawnedAt: number) => number[];
  alive: (pid: number) => boolean;
  wait: (ms: number) => Promise<void>;
}

const defaultDeps: StopDeps = {
  list: listCliProcesses,
  ancestors: () => panelAncestors(),
  // Через `killPidTree`: снятие помечается нарочным, и наблюдатель за выходом
  // CLI не примет код 1 после `TerminateProcess` на Windows за падение.
  kill: (pid, spawnedAt) => killPidTree(pid, { spawnedAt }),
  alive: isAlive,
  wait: (ms) => new Promise((done) => setTimeout(done, ms)),
};

/**
 * Снятие не тронуло ни одного процесса — почему? `killPidTree` отдаёт `[]` в
 * трёх случаях, и человеку они говорят разное (F-145):
 * - процесс вышел сам между сверкой и снятием — `gone`;
 * - номер успел занять другой процесс (создан позже сверки) — `reused`;
 * - снимка процессов нет (таймаут, отказ системы, F-205): номер со сверкой
 *   времени не трогается, а процесс сессии жив — `unverified`. Раньше это
 *   читалось «процесса уже не было», и человек уходил, оставив CLI работать.
 * Отличает их повторная сверка тем же списком CLI. `reused` — только по
 * доказательству (под номером виден другой процесс); номер, которого нет в
 * списке CLI, опознать нечем — это тоже `unverified`, а не догадка.
 */
async function untouchedOutcome(
  sessionId: string,
  pid: number,
  startedAtMs: number,
  deps: StopDeps,
): Promise<SessionStopResult> {
  if (!deps.alive(pid)) return { result: 'gone', pid };
  const now = (await deps.list())?.find((item) => item.pid === pid);
  const same =
    now !== undefined &&
    sessionIdsInCommand(now.commandLine).includes(sessionId.toLowerCase()) &&
    Math.abs(now.startedAtMs - startedAtMs) <= START_TOLERANCE_MS;
  if (now && !same) return { result: 'reused', pid };
  return { result: 'unverified', pid };
}

/**
 * Снять процесс сессии вне панели. Снимаем только то, что человек видел в окне
 * подтверждения: под номером всё ещё CLI этой сессии, созданный тогда же. Иначе
 * номер занял другой процесс — не трогаем ничего и говорим об этом.
 */
export async function stopSessionProcess(
  sessionId: string,
  body: SessionStopBody,
  deps: StopDeps = defaultDeps,
): Promise<SessionStopResult> {
  const { pid } = body;
  const current = (await deps.list())?.find((item) => item.pid === pid);
  // Номера нет среди CLI или список не получен вовсе: «уже нет» — только когда
  // номер и правда мёртв. Живой номер опознать нечем — тот же `unverified`, что
  // у отказавшего снятия: не догадка и не снятие вслепую (F-145b).
  if (!current) return { result: deps.alive(pid) ? 'unverified' : 'gone', pid };

  const shownAt = Date.parse(body.startedAt);
  const sameSession = sessionIdsInCommand(current.commandLine).includes(sessionId.toLowerCase());
  if (
    !sameSession ||
    !Number.isFinite(shownAt) ||
    Math.abs(current.startedAtMs - shownAt) > START_TOLERANCE_MS
  ) {
    return { result: 'reused', pid };
  }

  if (!body.allowPanel) {
    // Не знаем предков — не знаем, не снимем ли саму панель: ничего не трогаем.
    const ancestors = await deps.ancestors();
    if (!ancestors) return { result: 'unverified', pid };
    if (ancestors.has(pid)) return { result: 'owns-panel', pid };
  }

  const killed = deps.kill(pid, current.startedAtMs);
  if (killed.length === 0) return untouchedOutcome(sessionId, pid, current.startedAtMs, deps);

  // Сигнал ушёл — ждём, пока номер освободится: «остановлено» говорим по факту.
  for (let attempt = 0; attempt < 15 && deps.alive(pid); attempt += 1) await deps.wait(200);
  return { result: deps.alive(pid) ? 'still-running' : 'stopped', pid, killed: killed.length };
}
