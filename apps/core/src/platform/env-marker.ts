import { readFileSync, readdirSync } from 'node:fs';
import { currentOs, hasValue, reasonOf, type Fact, type OsKind } from './os-kind.ts';
import { osProcessTable, type ProcessIdentity, type ProcessTableSource } from './process-table.ts';
import { runTool, type ToolRun } from './run-tool.ts';
import { runWinHelper, type HelperOp } from './win-helper.ts';

/**
 * Поиск процессов по метке окружения дерева (03 §Launcher, P53): сирота, чей родитель
 * вышел (`cmd &` форкает копию оболочки и выходит, двойной fork демона), перепривязана к
 * init и обходу дерева не видна — свой её делает только унаследованная метка.
 * Linux — `/proc/<pid>/environ` (свои процессы читаются без прав root); macOS —
 * `ps -E` (окружение процессов того же пользователя после строки запуска); Windows —
 * помощник `environ` (`win-helper.ts`): блок окружения каждого процесса из его PEB, один
 * вызов на весь поиск, личность (номер + время создания) с того же дескриптора.
 *
 * Непрочитанное на Windows — факт, а не догадка (`judgeWinEnviron`). Метку несёт только
 * процесс, созданный нашим деревом обычным `CreateProcess`: он под копией нашего маркера
 * (тот же пользователь, тот же уровень целостности, DACL по умолчанию даёт нам чтение) —
 * его окружение читается. Поэтому не считаются: процесс чужого пользователя и процесс,
 * чей маркер закрыт для нас; процесс выше нашего уровня целостности (повышение идёт через
 * посредника — UAC/AppInfo, планировщик, службы, — и окружение ему строит посредник);
 * защищённый процесс (PPL: создание по подписи). Свой процесс на нашем уровне или ниже,
 * не защищённый, но не прочитанный, — может быть меченым: без находки ответ `unknown`.
 * Остаток (назван в 09): процесс нашего дерева, сам закрывший свой DACL, не виден ни поиску,
 * ни снятию (`kill` тоже открывает дескриптор).
 */

/** Чьих непрочитанных опасаться: метку раздаёт только дерево корня. */
export interface MarkerSweepScope {
  /**
   * Старт корня (мс Unix). Окружение задаётся при запуске, поэтому свой непрочитанный, родившийся
   * раньше корня (запас — секунда точности старта Linux), метку не несёт и сомнением не считается.
   */
  bornAfterMs?: number;
}

export type MarkerSweep = (
  name: string,
  value: string,
  scope?: MarkerSweepScope,
) => Promise<Fact<ProcessIdentity[]>>;

/** Есть ли `name=value` среди строк `environ` (разделитель — NUL). */
export function environHas(environ: string, name: string, value: string): boolean {
  const wanted = `${name}=${value}`;
  return environ.split('\0').some((entry) => entry === wanted);
}

/** Номера из вывода `ps -E -ww -A -o pid= -o command=`, где окружение несёт метку. */
export function parsePsEnvironment(text: string, name: string, value: string): number[] {
  const wanted = `${name}=${value}`;
  const pids: number[] = [];
  for (const line of text.split(/\r?\n/)) {
    const match = /^\s*(\d+)\s+(.*)$/.exec(line);
    if (!match) continue;
    // Окружение идёт словами `ИМЯ=значение` через пробел после argv: метка — отдельное слово.
    if ((match[2] ?? '').split(/\s+/).includes(wanted)) pids.push(Number(match[1]));
  }
  return pids;
}

/** Свой процесс, чьё окружение не прочитано: RID уровня целостности и `PS_PROTECTION` (-1 — ОС не сказала). */
export interface WinHidden extends ProcessIdentity {
  il: number;
  protection: number;
}

/** Разобранный вывод помощника `environ`. */
export interface WinEnvironScan {
  readerIl: number;
  hits: ProcessIdentity[];
  /** Открыт на чтение памяти, живой, но блок не прочитан. */
  unread: ProcessIdentity[];
  hidden: WinHidden[];
  read: number;
  gone: number;
  other: number;
  closed: number;
}

const ID_LINE = /^(hit|unread) (\d+) (\d+)$/;
const HIDDEN_LINE = /^hidden (\d+) (\d+) (\d+) (-?\d+)$/;

/** `undefined` — нет строки `reader` или итоговой `done`: вывод оборван, это не ответ. */
export function parseWinEnviron(text: string): WinEnvironScan | undefined {
  const scan: Partial<WinEnvironScan> & Pick<WinEnvironScan, 'hits' | 'unread' | 'hidden'> = {
    hits: [],
    unread: [],
    hidden: [],
  };
  let done = false;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    const reader = /^reader (\d+)$/.exec(line);
    if (reader) scan.readerIl = Number(reader[1]);
    const id = ID_LINE.exec(line);
    // Время создания 0 — ОС его не сказала: без него нет личности (как строка таблицы без старта).
    // Меченый процесс без личности — не «меченых нет», а непрочитанный свой (F-55): в `unread`.
    // Непрочитанный без личности, как и прежде, не считается (процесс ушёл между снимком и чтением).
    if (id) {
      const proven = id[3] !== '0';
      if (proven)
        (id[1] === 'hit' ? scan.hits : scan.unread).push({
          pid: Number(id[2]),
          start: id[3] ?? '',
        });
      else if (id[1] === 'hit') scan.unread.push({ pid: Number(id[2]), start: '' });
    }
    const hidden = HIDDEN_LINE.exec(line);
    if (hidden)
      scan.hidden.push({
        pid: Number(hidden[1]),
        start: hidden[2] ?? '',
        il: Number(hidden[3]),
        protection: Number(hidden[4]),
      });
    const total = /^done (\d+) (\d+) (\d+) (\d+)$/.exec(line);
    if (total) {
      done = true;
      [scan.read, scan.gone, scan.other, scan.closed] = total.slice(1).map(Number);
    }
  }
  if (!done || scan.readerIl === undefined) return undefined;
  return scan as WinEnvironScan;
}

/**
 * Решение по фактам помощника (правило — в шапке модуля). Находка доказывает себя сама:
 * есть меченый процесс — ответ он, даже если рядом есть непрочитанные свои.
 */
export function judgeWinEnviron(scan: WinEnvironScan): Fact<ProcessIdentity[]> {
  if (scan.hits.length > 0) return { value: scan.hits };
  // Ни одного прочитанного блока (а свой родитель помощника читается всегда) — сломано само чтение.
  if (scan.read === 0) return { unknown: 'env-marker sweep: no environment block was readable' };
  const suspects = [
    ...scan.unread,
    ...scan.hidden.filter((h) => h.il <= scan.readerIl && !(h.protection > 0)),
  ];
  if (suspects.length === 0) return { value: [] };
  const pids = suspects.map((s) => s.pid);
  return {
    unknown: `env-marker sweep: ${pids.length} process(es) of this user at or below our integrity level are unreadable (pid ${pids.slice(0, 8).join(', ')})`,
  };
}

async function windowsMarked(
  wanted: string,
  helper: (op: HelperOp, plan: string) => Promise<ToolRun>,
): Promise<Fact<ProcessIdentity[]>> {
  const run = await helper('environ', wanted);
  if (!run.ok) return { unknown: `env-marker sweep: ${run.reason}` };
  const scan = parseWinEnviron(run.stdout);
  if (!scan) return { unknown: 'env-marker sweep: helper output is incomplete' };
  return judgeWinEnviron(scan);
}

/** Чтения `/proc` для поиска на Linux (подменяются в тестах: EACCES своего процесса не поставить). */
export interface LinuxEnvironIo {
  readEnviron(pid: string): string;
  /**
   * Чей процесс: `self` — того же пользователя, что ядро; `exited` — зомби или уже вышел
   * (environ зомби отдаёт EACCES, хотя он ничего не исполняет и ничего не держит).
   */
  ownerOf(pid: string): 'self' | 'other' | 'exited' | 'unknown';
}

function realLinuxIo(proc: string): LinuxEnvironIo {
  return {
    readEnviron: (pid) => readFileSync(`${proc}/${pid}/environ`, 'latin1'),
    // Владелец — из `status` (строка `Uid:`, читается всеми): у не-dumpable процесса сам
    // каталог `/proc/<pid>` принадлежит root, и `stat` назвал бы своего демона чужим.
    ownerOf: (pid) => {
      try {
        const status = readFileSync(`${proc}/${pid}/status`, 'utf8');
        // Зомби (Z) и умирающий (X): environ закрыт EACCES, но ни метку, ни ресурс он не держит
        // (F-64: каждая остановка с ещё не собранным потомком иначе была бы «не доказана»).
        if (/^State:\s+[ZX]/m.test(status)) return 'exited';
        const uid = /^Uid:\s+(\d+)/m.exec(status)?.[1];
        if (uid === undefined) return 'unknown';
        return Number(uid) === process.getuid?.() ? 'self' : 'other';
      } catch (error) {
        // Вышел между чтениями — снимать нечего; иной отказ — владелец не доказан.
        const code = (error as NodeJS.ErrnoException).code;
        return code === 'ENOENT' || code === 'ESRCH' ? 'exited' : 'unknown';
      }
    },
  };
}

/**
 * Один процесс (F-55): EACCES у процесса ТОГО ЖЕ пользователя — не «чужой», а закрывшийся
 * (не-dumpable демон: ssh-agent, gpg-agent — те самые двойные fork, ради которых метка), он может
 * быть меченым. Вышедший (ENOENT/ESRCH), зомби и чужой — не наши (`undefined`).
 */
function environRead(
  entry: string,
  name: string,
  value: string,
  io: LinuxEnvironIo,
): 'marked' | 'clean' | 'unread' | undefined {
  try {
    return environHas(io.readEnviron(entry), name, value) ? 'marked' : 'clean';
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ESRCH') return undefined;
    const owner = io.ownerOf(entry);
    return owner === 'self' || owner === 'unknown' ? 'unread' : undefined;
  }
}

interface LinuxScan {
  pids: number[];
  unread: number[];
}

function linuxMarked(name: string, value: string, proc: string, io: LinuxEnvironIo): LinuxScan {
  const scan: LinuxScan = { pids: [], unread: [] };
  for (const entry of readdirSync(proc)) {
    if (!/^\d+$/.test(entry)) continue;
    const read = environRead(entry, name, value, io);
    if (read === 'marked') scan.pids.push(Number(entry));
    else if (read === 'unread') scan.unread.push(Number(entry));
  }
  return scan;
}

const SETTLE_MS = 100;

/**
 * Свой непрочитанный без находки — ещё не сомнение (C5 на Linux, 28.10): иначе на рабочем столе с
 * ssh-agent любая остановка «не доказана». Старше корня (`scope`) — метку не несёт, судится по
 * таблице без ожидания; выходящий процесс (память уже снята, состояние ещё не Z) отдаёт EACCES
 * мгновение — второй взгляд через 100 мс его не видит. Таблица не прочиталась — все под сомнением.
 */
async function settleUnread(
  name: string,
  value: string,
  scan: LinuxScan,
  io: LinuxEnvironIo,
  source: ProcessTableSource,
  scope: MarkerSweepScope,
): Promise<LinuxScan> {
  let left = scan.unread;
  if (scope.bornAfterMs !== undefined) {
    const table = await source.read();
    const after = scope.bornAfterMs - 1_000;
    if (hasValue(table))
      left = left.filter((pid) => {
        const row = table.value.find((item) => item.pid === pid);
        // Время старта не названо (`NaN`) — младшим не исключить: остаётся.
        return row !== undefined && !row.zombie && !(row.startMs < after);
      });
  }
  if (left.length === 0) return { pids: [], unread: [] };
  await new Promise((done) => setTimeout(done, SETTLE_MS));
  const settled: LinuxScan = { pids: [], unread: [] };
  for (const pid of left) {
    const read = environRead(String(pid), name, value, io);
    if (read === 'marked') settled.pids.push(pid);
    else if (read === 'unread') settled.unread.push(pid);
  }
  return settled;
}

export async function sweepMarker(
  name: string,
  value: string,
  source: ProcessTableSource = osProcessTable(),
  os: OsKind = currentOs(),
  proc = '/proc',
  helper: (op: HelperOp, plan: string) => Promise<ToolRun> = runWinHelper,
  linuxIo: LinuxEnvironIo = realLinuxIo(proc),
  scope: MarkerSweepScope = {},
): Promise<Fact<ProcessIdentity[]>> {
  // Личность находки Windows — с дескриптора, которым читалось окружение: таблица не нужна.
  if (os === 'win32') return windowsMarked(`${name}=${value}`, helper);
  let pids: number[];
  if (os === 'linux') {
    try {
      let marked = linuxMarked(name, value, proc, linuxIo);
      if (marked.pids.length === 0 && marked.unread.length > 0)
        marked = await settleUnread(name, value, marked, linuxIo, source, scope);
      // Как на Windows: находка доказывает себя сама; без неё свой непрочитанный — `unknown`.
      if (marked.pids.length === 0 && marked.unread.length > 0) {
        return {
          unknown: `env-marker sweep: ${marked.unread.length} own process(es) with unreadable environ (pid ${marked.unread.slice(0, 8).join(', ')})`,
        };
      }
      pids = marked.pids;
    } catch (error) {
      return { unknown: `env-marker sweep: ${reasonOf(error)}` };
    }
  } else {
    const run = await runTool('ps', ['-E', '-ww', '-A', '-o', 'pid=', '-o', 'command='], {
      env: { ...process.env, LC_ALL: 'C' },
    });
    if (!run.ok) return { unknown: `ps -E: ${run.reason}` };
    pids = parsePsEnvironment(run.stdout, name, value);
  }
  if (pids.length === 0) return { value: [] };
  const table = await source.read();
  if (!hasValue(table)) return table;
  const ids: ProcessIdentity[] = [];
  for (const pid of pids) {
    const row = table.value.find((item) => item.pid === pid);
    if (row?.start && !row.zombie) ids.push({ pid: row.pid, start: row.start });
  }
  return { value: ids };
}

/** Настоящий поиск в форме `MarkerSweep` (таблица и ОС — по умолчанию текущие). */
export function markerSweep(
  source: ProcessTableSource = osProcessTable(),
  os: OsKind = currentOs(),
): MarkerSweep {
  return (name, value, scope) =>
    sweepMarker(name, value, source, os, undefined, undefined, undefined, scope);
}
