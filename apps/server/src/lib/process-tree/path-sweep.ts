import { Buffer } from 'node:buffer';
import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import process from 'node:process';
import {
  etimeSeconds,
  filetimeFromMs,
  terminateByHandle,
  type KillOutcome,
  type KillTarget,
  type ProcessRow,
} from '../kill-tree.mjs';
import { spawnRecords, type SpawnRecord } from '../cli-spawn/spawn-registry.ts';
import { readMarks } from './process-env-mark.ts';

/**
 * Добор процессов копии группы после паузы (N1b/N1c, 23.10): то, что группа
 * завела и что пережило её CLI, — dev-сервер vite, цепочка tests-cli → vitest,
 * чей родитель-оболочка умер раньше и обход дерева от CLI её уже не видел.
 * Признак «это процесс копии» — путь копии в командной строке. Не по имени
 * (`node.exe` — это и сервер панели, и стенд человека), не по порту (`:5173`
 * у владельца — свой стенд), а только по пути, которого вне копии нет.
 * Одного пути мало (F-34): его несут и редактор человека на копии, и команда из
 * его терминала, — поэтому снимается только то, что по цепочке предков завела
 * панель (`ownedByPanel`).
 *
 * Снимок — асинхронный (CIM на Windows ~1 с держал бы сервер), снятие на
 * Windows — по дескриптору со сверкой времени создания: номер, освободившийся
 * за время снимка и занятый чужим, не снимается. Помощника нет — не снимается
 * ничего: по голому номеру чужое не трогаем.
 */

export interface CommandRow extends ProcessRow {
  command: string;
}

export interface SweepImpl {
  platform?: string;
  readTable?: () => Promise<CommandRow[] | undefined>;
  /** Снятие по дескриптору (Windows); `undefined` — помощник недоступен. */
  terminate?: (targets: readonly KillTarget[]) => Map<number, KillOutcome> | undefined;
  /** Сигнал по номеру (POSIX). */
  kill?: (pid: number, signal: NodeJS.Signals) => void;
  selfPid?: number;
  /**
   * Переменная окружения, которую несёт каждый процесс группы (профиль группы
   * кладёт её в окружение CLI, потомки наследуют). Она — доказательство «завела
   * группа» для сироты, чей родитель не записан в реестре запусков (RF-BGCD-09):
   * Linux — `/proc/<pid>/environ`, Windows — PEB, macOS — `ps -E`.
   */
  mark?: string;
  /** Окружение процесса сырым текстом (`NAME=value\0…`); `undefined` — не прочесть. */
  readEnv?: (pid: number) => string | undefined;
  /**
   * Метка разом для кандидатов (Windows — PEB через помощник, macOS — `ps -E`):
   * номер → есть ли метка. Без ответа по номеру — метки нет.
   */
  readMarks?: (
    rows: readonly CommandRow[],
    name: string,
  ) => Promise<Map<number, boolean> | undefined>;
  /** Записи реестра запусков (`cli-spawn/spawn-registry.ts`); по умолчанию — живой реестр. */
  spawned?: readonly SpawnRecord[];
}

export interface PlanOptions {
  selfPid?: number;
  marked?: (pid: number) => boolean;
  /** Что запустил сервер; нет записей — оборванная цепочка своей не считается. */
  spawned?: readonly SpawnRecord[];
  nowMs?: number;
  platform?: string;
}

const TABLE_TIMEOUT_MS = 20_000;
/** Два снимка `ps` выводят время создания из `etime` (секунды) в разные моменты: 2 с допуска. */
const POSIX_CREATED_SLACK = filetimeFromMs(2_000) - filetimeFromMs(0);

/**
 * Снимок с командными строками. Строка — base64 UTF-8: в командной строке
 * бывают переводы строк и любые знаки, а разбор по пробелам их бы не пережил.
 */
const CIM_SCRIPT = `$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
Get-CimInstance -ClassName Win32_Process -Property ProcessId,ParentProcessId,CreationDate,CommandLine | ForEach-Object {
  $created = 0
  if ($_.CreationDate) { $created = $_.CreationDate.ToFileTimeUtc() }
  $cmd = ''
  if ($_.CommandLine) { $cmd = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($_.CommandLine)) }
  [Console]::Out.Write("$($_.ProcessId) $($_.ParentProcessId) $created $cmd" + [char]10)
}
`;

/** Строки `pid ppid created base64` (Windows) → снимок; пустой разбор — снимка нет. */
export function parseCimCommandTable(text: string): CommandRow[] | undefined {
  const rows: CommandRow[] = [];
  for (const line of text.split(/\r?\n/)) {
    const match = /^(\d+) (\d+) (\d+) ?([A-Za-z0-9+/=]*)$/.exec(line.trim());
    if (!match) continue;
    rows.push({
      pid: Number(match[1]),
      ppid: Number(match[2]),
      created: BigInt(match[3] ?? '0'),
      command: Buffer.from(match[4] ?? '', 'base64').toString('utf8'),
    });
  }
  return rows.length > 0 ? rows : undefined;
}

/** Вывод `ps -A -o pid= -o ppid= -o etime= -o args=` → снимок той же формы. */
export function parsePsCommandTable(text: string, nowMs: number): CommandRow[] | undefined {
  const rows: CommandRow[] = [];
  for (const line of text.split(/\r?\n/)) {
    const match = /^\s*(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/.exec(line);
    const seconds = match ? etimeSeconds(match[3] ?? '') : undefined;
    if (!match || seconds === undefined) continue;
    rows.push({
      pid: Number(match[1]),
      ppid: Number(match[2]),
      created: filetimeFromMs(nowMs - seconds * 1000),
      command: match[4] ?? '',
    });
  }
  return rows.length > 0 ? rows : undefined;
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

/** Снимок процессов с командными строками или `undefined`, если его не получить. */
export function readCommandTable(
  platform: string = process.platform,
): Promise<CommandRow[] | undefined> {
  return new Promise((done) => {
    const now = Date.now();
    const finish = (error: Error | null, stdout: string): void => {
      if (error) done(undefined);
      else
        done(
          platform === 'win32' ? parseCimCommandTable(stdout) : parsePsCommandTable(stdout, now),
        );
    };
    try {
      if (platform === 'win32') {
        execFile(
          powershellPath(),
          [
            '-NoProfile',
            '-NonInteractive',
            '-EncodedCommand',
            Buffer.from(CIM_SCRIPT, 'utf16le').toString('base64'),
          ],
          {
            encoding: 'utf8',
            windowsHide: true,
            timeout: TABLE_TIMEOUT_MS,
            maxBuffer: 64 * 1024 * 1024,
          },
          finish,
        );
      } else {
        execFile(
          'ps',
          ['-A', '-o', 'pid=', '-o', 'ppid=', '-o', 'etime=', '-o', 'args='],
          { encoding: 'utf8', timeout: TABLE_TIMEOUT_MS, maxBuffer: 64 * 1024 * 1024 },
          finish,
        );
      }
    } catch {
      done(undefined);
    }
  });
}

/** Путь Windows-формы — с буквой диска или UNC: регистр у него не различается. */
function windowsShaped(path: string): boolean {
  return /^[a-z]:[\\/]/i.test(path) || /^[\\/]{2}[^\\/]/.test(path);
}

/** Прямые слэши, без повторов и хвостового; регистр складывается у путей Windows-формы. */
function comparable(text: string, fold: boolean): string {
  const slashed = text.replace(/[\\/]+/g, '/');
  return fold ? slashed.toLowerCase() : slashed;
}

/**
 * Каталог, который можно мести: хотя бы две части пути под корнем (под буквой
 * диска). `C:\`, `/`, `/home` в чужих командных строках есть у всех — такой
 * «копией» снесли бы полмашины.
 */
function sweepableRoot(dir: string): string | undefined {
  const fold = windowsShaped(dir);
  const root = comparable(dir, fold).replace(/\/$/, '');
  const parts = root.split('/').filter(Boolean);
  const below = fold && /^[a-z]:$/i.test(parts[0] ?? '') ? parts.length - 1 : parts.length;
  return below >= 2 ? root : undefined;
}

/**
 * Хозяева процессов человека: оболочка рабочего стола, терминалы, редакторы и
 * IDE. Всё под ними — человека, даже с путём копии в командной строке (F-34:
 * «открыть в редакторе» открывает копию в VS Code, его tsserver и терминал
 * несут путь копии). Группа такого не заводит, а если и завела редактор —
 * снимать окно человеку под руку хуже, чем оставить.
 */
const HUMAN_HOSTS = new Set([
  'explorer',
  'windowsterminal',
  'wt',
  'mintty',
  'conemu',
  'conemu64',
  'alacritty',
  'wezterm',
  'wezterm-gui',
  'kitty',
  'hyper',
  'tabby',
  'gnome-shell',
  'gnome-terminal-server',
  'kgx',
  'konsole',
  'plasmashell',
  'xfce4-terminal',
  'xterm',
  'tilix',
  'terminator',
  'tmux',
  'screen',
  'code',
  'code - insiders',
  'code-insiders',
  'codium',
  'vscodium',
  'cursor',
  'windsurf',
  'zed',
  'sublime_text',
  'subl',
  'notepad',
  'notepad++',
  'devenv',
  'fleet',
  'idea',
  'idea64',
  'webstorm',
  'webstorm64',
  'pycharm',
  'pycharm64',
  'rider',
  'rider64',
  'goland',
  'goland64',
  'clion',
  'clion64',
  'phpstorm',
  'phpstorm64',
  'rubymine',
  'rubymine64',
  'datagrip',
  'datagrip64',
  'studio',
  'studio64',
  'emacs',
  'gvim',
  'nvim-qt',
  'neovide',
]);

/**
 * Имя исполняемого в голове командной строки: кавычки, `….exe` с пробелами в
 * пути без кавычек, пакет приложения macOS (`….app/Contents/MacOS/…` — это
 * всегда окно, хозяин человека).
 */
function hostName(command: string): string | undefined {
  const text = command.trim();
  if (/\.app\/Contents\/MacOS\//.test(text)) return 'macos-app';
  let head: string;
  if (text.startsWith('"')) {
    const close = text.indexOf('"', 1);
    head = close > 0 ? text.slice(1, close) : text.slice(1);
  } else {
    const exe = /^.*?\.exe(?=\s|$)/i.exec(text);
    head = exe ? exe[0] : (text.split(/\s+/)[0] ?? '');
  }
  const base = head.split(/[\\/]/).pop() ?? '';
  // `tmux: server` — так tmux переименовывает свой процесс.
  return (
    base
      .replace(/\.exe$/i, '')
      .replace(/:$/, '')
      .toLowerCase() || undefined
  );
}

function humanHost(command: string): boolean {
  const name = hostName(command);
  return name === 'macos-app' || (name !== undefined && HUMAN_HOSTS.has(name));
}

/** Запас сверки времени создания с моментом запуска: событие `spawn` приходит после создания. */
const SPAWN_SLACK_MS = 2_000;

/**
 * Верх оборванной цепочки — запущенный сервером процесс или его ребёнок
 * (реестр `cli-spawn/spawn-registry.ts`, RF-BGCD-09):
 * - сам записан и жив: время создания — у момента запуска;
 * - его родитель записан и мёртв (Windows хранит номер мёртвого родителя): ребёнок
 *   создан, пока записанный жил, — между его запуском и выходом. Номер, отданный
 *   потом чужому, детей чужого своими не делает.
 * POSIX передаёт сироту init или субжнецу и номер родителя теряет — там второе
 * правило не срабатывает, и своё доказывает метка в окружении.
 */
function spawnedByServer(
  top: CommandRow,
  spawned: readonly SpawnRecord[],
  nowMs: number,
  exitSlack: bigint,
): boolean {
  const slack = filetimeFromMs(SPAWN_SLACK_MS) - filetimeFromMs(0);
  return spawned.some((record) => {
    const born = filetimeFromMs(record.spawnedAt);
    if (record.pid === top.pid && record.exitedAt === undefined) {
      return top.created >= born - slack && top.created <= born + slack;
    }
    if (record.pid !== top.ppid) return false;
    const gone = filetimeFromMs(record.exitedAt ?? nowMs) + exitSlack;
    return top.created >= born - slack && top.created <= gone;
  });
}

/**
 * Чей процесс — по живой цепочке предков (родитель признаётся, только если он
 * старше ребёнка: номер мёртвого родителя мог занять чужой; ppid 0/1 — сирота,
 * переданная init/launchd, цепочка обрывается).
 * - дошли до сервера панели — дерево CLI группы, своё;
 * - по дороге редактор, терминал, оболочка рабочего стола — человека;
 * - в окружении метка группы — своя: сирота группы несёт её и тогда, когда его
 *   подобрал `systemd --user` (субжнец старше сервера, нередко и его предок), и
 *   тогда, когда между ним и CLI была оболочка, жившая миллисекунды (Git Bash:
 *   `cmd &` — родитель-оболочка вышел сразу, номер его не записан нигде);
 * - дошли до предка сервера мимо самого сервера — соседнее дерево (терминал, из
 *   которого человек поднял панель), чужое;
 * - цепочка оборвалась — своя, только если её верх запустил сервер или его
 *   ребёнок (`spawnedByServer`). Возраст больше ничего не решает (RF-BGCD-09):
 *   процесс человека, поднятый в копии группы после старта панели, — чужой.
 */
function ownedByPanel(
  start: CommandRow,
  byPid: ReadonlyMap<number, CommandRow>,
  server: CommandRow | undefined,
  serverAncestors: ReadonlySet<number>,
  marked: ((pid: number) => boolean) | undefined,
  spawnedTop: (top: CommandRow) => boolean,
): boolean {
  let cursor = start;
  let neighbour = false;
  for (const seen = new Set<number>(); !seen.has(cursor.pid);) {
    seen.add(cursor.pid);
    if (server && cursor.pid === server.pid) return true;
    if (humanHost(cursor.command)) return false;
    if (serverAncestors.has(cursor.pid)) {
      neighbour = true;
      break;
    }
    const parent = byPid.get(cursor.ppid);
    if (
      !parent ||
      parent.pid <= 1 ||
      parent.pid === cursor.pid ||
      parent.created > cursor.created
    ) {
      break;
    }
    cursor = parent;
  }
  if (marked?.(start.pid)) return true;
  if (neighbour) return false;
  return spawnedTop(cursor);
}

/** Окружение процесса Linux; чужой пользователь, вышедший процесс — `undefined`. */
function procEnviron(pid: number): string | undefined {
  try {
    return readFileSync(`/proc/${pid}/environ`, 'utf8');
  } catch {
    return undefined;
  }
}

/** В сыром окружении (`A=1\0B=2`) есть переменная `name` с непустым значением. */
export function environHas(environ: string | undefined, name: string): boolean {
  return Boolean(
    environ
      ?.split('\0')
      .some((pair) => pair.startsWith(`${name}=`) && pair.length > name.length + 1),
  );
}

/**
 * Чистый план: номера процессов, в чьей командной строке есть путь `dir` как
 * путь (за ним — разделитель, кавычка, пробел или конец строки: `feat-1` не
 * задевает `feat-10`) и которые завела группа (`ownedByPanel`). Никогда — сам
 * сервер и его предки: панель, запущенная из той же папки, не снимает себя.
 * Новые вперёд — дети раньше родителей.
 */
export function planPathSweep(
  table: readonly CommandRow[],
  dir: string,
  options: PlanOptions = {},
): number[] {
  const root = sweepableRoot(dir);
  if (!root) return [];
  const fold = windowsShaped(dir);
  const byPid = new Map(table.map((row) => [row.pid, row]));
  const protectedPids = new Set<number>();
  // Предки сервера — по номеру родителя, пока родитель старше ребёнка: номер
  // мёртвого родителя мог занять чужой процесс.
  const server = byPid.get(options.selfPid ?? process.pid);
  let cursor = server;
  if (!cursor) protectedPids.add(options.selfPid ?? process.pid);
  while (cursor && !protectedPids.has(cursor.pid)) {
    protectedPids.add(cursor.pid);
    const parent = byPid.get(cursor.ppid);
    if (!parent || parent.pid === cursor.pid || parent.created > cursor.created) break;
    cursor = parent;
  }
  const serverAncestors = new Set([...protectedPids].filter((pid) => pid !== server?.pid));
  const nowMs = options.nowMs ?? Date.now();
  // POSIX выводит время создания из `etime` с точностью до секунды — запас на выход.
  const exitSlack = (options.platform ?? process.platform) === 'win32' ? 0n : POSIX_CREATED_SLACK;
  const spawnedTop = (top: CommandRow): boolean =>
    spawnedByServer(top, options.spawned ?? [], nowMs, exitSlack);
  const after = /^(?:$|[/"'\s])/;
  // И перед путём — граница: `/tmp/wt` не задевает `/var/tmp/wt`. Путь Windows
  // может стоять за слэшем адреса файла (`file:///C:/…`), путь POSIX — нет.
  const before = fold ? /^(?:$|[/"'\s=,;(])/ : /^(?:$|["'\s=,;(])/;
  const inside = (command: string): boolean => {
    const text = comparable(command, fold);
    for (let at = text.indexOf(root); at >= 0; at = text.indexOf(root, at + 1)) {
      const next = text.slice(at + root.length, at + root.length + 1);
      if (before.test(text.slice(Math.max(0, at - 1), at)) && after.test(next)) return true;
    }
    return false;
  };
  return table
    .filter(
      (row) =>
        row.created > 0n &&
        !protectedPids.has(row.pid) &&
        inside(row.command) &&
        ownedByPanel(row, byPid, server, serverAncestors, options.marked, spawnedTop),
    )
    .sort((a, b) => (a.created === b.created ? 0 : a.created > b.created ? -1 : 1))
    .map((row) => row.pid);
}

/**
 * Метка группы в окружении кандидатов (RF-BGCD-09). Кандидат — процесс с путём
 * копии, которого метка сделала бы своим (план при «метка у всех»): окружение
 * остальных не читается вовсе. Linux — `/proc/<pid>/environ` (или поданный
 * `readEnv`), Windows и macOS — одним вызовом помощника на все копии. Не
 * прочесть — метки нет: снимается только доказанное реестром.
 */
async function groupMarks(
  table: readonly CommandRow[],
  dirs: readonly string[],
  base: PlanOptions,
  platform: string,
  impl: SweepImpl,
): Promise<((pid: number) => boolean) | undefined> {
  const mark = impl.mark;
  if (!mark) return undefined;
  const readEnv = impl.readEnv ?? (platform === 'linux' ? procEnviron : undefined);
  if (readEnv) return (pid: number) => environHas(readEnv(pid), mark);
  const candidates = new Set(
    dirs.flatMap((dir) => planPathSweep(table, dir, { ...base, marked: () => true })),
  );
  if (candidates.size === 0) return undefined;
  const rows = table.filter((row) => candidates.has(row.pid));
  const read = impl.readMarks ?? ((list, name) => readMarks(list, name, platform));
  const marks = await read(rows, mark);
  return marks ? (pid: number) => marks.get(pid) === true : undefined;
}

/**
 * Снять процессы, чья командная строка указывает в `dir`. Номера, по которым
 * ушёл сигнал; снимка нет — пусто. Ошибки глушатся: добор после паузы — страховка,
 * и ответ человеку от неё не зависит.
 */
export function sweepPathProcesses(dir: string, impl: SweepImpl = {}): Promise<number[]> {
  return sweepPathsProcesses([dir], impl);
}

/**
 * То же для нескольких копий одним снимком (пауза дерева снимает все группы
 * разом — снимок CIM ~1 с на каждую был бы лишним).
 */
export async function sweepPathsProcesses(
  dirs: readonly string[],
  impl: SweepImpl = {},
): Promise<number[]> {
  try {
    if (dirs.length === 0) return [];
    // Срез — до снимка (F-69): CIM идёт ~1 с, и группу за это время могут снять с паузы.
    // Её свежие процессы в той же копии — не наследство паузы. На POSIX время создания
    // выведено из `etime` с округлением вниз, то есть не раньше настоящего, — свежий
    // процесс срез не пропустит, а родившийся за секунду до вызова просто уцелеет.
    const cutoff = filetimeFromMs(Date.now());
    const platform = impl.platform ?? process.platform;
    const table = await (impl.readTable ?? (() => readCommandTable(platform)))();
    if (!table) return [];
    const base: PlanOptions = {
      ...(impl.selfPid ? { selfPid: impl.selfPid } : {}),
      spawned: impl.spawned ?? spawnRecords(),
      platform,
    };
    const marked = await groupMarks(table, dirs, base, platform, impl);
    const options: PlanOptions = { ...base, ...(marked ? { marked } : {}) };
    const born = new Map(table.map((row) => [row.pid, row.created]));
    const pids = [...new Set(dirs.flatMap((dir) => planPathSweep(table, dir, options)))].filter(
      (pid) => (born.get(pid) ?? cutoff + 1n) <= cutoff,
    );
    if (pids.length === 0) return [];
    if (platform === 'win32') {
      const outcomes = (impl.terminate ?? terminateByHandle)(
        pids.map((pid) => ({ pid, created: born.get(pid) })),
      );
      return outcomes ? pids.filter((pid) => outcomes.get(pid) === 'killed') : [];
    }
    // F-99: на POSIX сигнал идёт по голому номеру, а Windows сверяет время создания по
    // описателю. Второй снимок прямо перед сигналом: номер, за который успел встать другой
    // процесс (время создания другое), не трогается. Допуск — округление `etime` двух снимков.
    const again = await (impl.readTable ?? (() => readCommandTable(platform)))();
    if (!again) return [];
    const bornAgain = new Map(again.map((row) => [row.pid, row.created]));
    const same = (pid: number): boolean => {
      const first = born.get(pid);
      const second = bornAgain.get(pid);
      if (first === undefined || second === undefined) return false;
      const drift = first > second ? first - second : second - first;
      return drift <= POSIX_CREATED_SLACK;
    };
    const send = impl.kill ?? ((pid: number, signal: NodeJS.Signals) => process.kill(pid, signal));
    const killed: number[] = [];
    for (const pid of pids.filter(same)) {
      try {
        send(pid, 'SIGTERM');
        killed.push(pid);
      } catch {
        // Уже вышел.
      }
    }
    return killed;
  } catch {
    return [];
  }
}
