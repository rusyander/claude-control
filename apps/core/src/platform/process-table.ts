import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { currentOs, reasonOf, type Fact, type OsKind } from './os-kind.ts';
import { runTool } from './run-tool.ts';
import { runWinHelper } from './win-helper.ts';

/**
 * Таблица процессов ОС с ТОЧНЫМ временем старта (09 §process identity). Номер процесса
 * без времени старта — не личность: Windows и Linux раздают номера заново, и запись
 * прошлой жизни ядра указала бы на чужой процесс (F05, P12).
 *
 * `start` — непрозрачный точный токен ОС, сравнивается только на равенство:
 * - win32: FILETIME создания (100 нс) из `NtQuerySystemInformation`;
 * - linux: `<boot_id>:<starttime>` — тики с загрузки из `/proc/<pid>/stat` (поле 22) плюс
 *   id загрузки: после перезагрузки тот же номер с теми же тиками — другой процесс;
 * - darwin: `<epoch-сек lstart>:<хеш ucomm>` — `ps -o lstart=` точен до секунды, хеш имени
 *   учёта (`ucomm`, задаётся при exec) отличает переиспользованный в ту же секунду номер (09).
 *   Не argv: его переписывает `process.title` (node, libuv пишет в память argv), и личность
 *   живого процесса «умирала» бы после смены заголовка (F-59).
 * `startMs` — для порядка «ребёнок не старше родителя», не для сравнения личности.
 */

export interface ProcessIdentity {
  pid: number;
  start: string;
}

export interface ProcessRow extends ProcessIdentity {
  ppid: number;
  /** Время старта в мс Unix; `NaN` — ОС не сказала (System, Idle). */
  startMs: number;
  /** Зомби (вышел, родитель ещё не собрал код) — для личности мёртв: ничего не исполняет. */
  zombie?: boolean;
  /**
   * Имя образа процесса (A2-F02: псевдозадача узнаёт предка-CLI): win32 — `ImageName` снимка
   * (`claude.exe`), linux — `comm` из `/proc/<pid>/stat` (до 15 символов), darwin — `ucomm`.
   * Нет — ОС не сказала (System, Idle; снимок CIM без имени): предок не узнаётся.
   */
  image?: string;
  /**
   * Процессорное время процесса (user + kernel), мс — проба жизни затихшей сессии смотрит его
   * прирост (этап 8, F9). `null` или нет поля — снимок ОС его не отдал.
   */
  cpuMs?: number | null;
}

export interface ProcessTableSource {
  read(): Promise<Fact<ProcessRow[]>>;
}

const FILETIME_EPOCH_SHIFT_MS = 11_644_473_600_000n;
/** USER_HZ: в `/proc` тики всегда в сотых долях секунды на всех ходовых архитектурах. */
const LINUX_CLK_TCK = 100;

export function filetimeToMs(ticks: bigint): number {
  return Number(ticks / 10_000n - FILETIME_EPOCH_SHIFT_MS);
}

/**
 * Откуда процессор пробы на этой ОС — пишется в причину `session.probe` (R4: тики Linux взяты
 * при CLK_TCK = 100, у Node нет API спросить его; в контейнере номера — его пространства имён).
 */
export function cpuSourceOf(os: OsKind = currentOs()): string {
  if (os === 'win32') return 'cpu = user + kernel of the process snapshot (100 ns units)';
  if (os === 'darwin') return 'cpu = ps time (user + system)';
  return `cpu = /proc utime + stime at CLK_TCK = ${LINUX_CLK_TCK}`;
}

/**
 * Вывод помощника `table`: строки `pid ppid created cpu[ image]` — `cpu` в сотнях нс (user +
 * kernel) или `-`, если запасной путь CIM его не отдал; имя образа — остаток строки.
 */
export function parseWinTable(text: string): ProcessRow[] {
  const rows: ProcessRow[] = [];
  for (const line of text.split(/\r?\n/)) {
    const match = /^(\d+) (\d+) (\d+) (\d+|-)(?: (.+))?$/.exec(line.trim());
    if (!match) continue;
    const created = BigInt(match[3] ?? '0');
    const cpu = match[4] === '-' ? null : Number(BigInt(match[4] ?? '0') / 10_000n);
    const image = match[5]?.trim();
    rows.push({
      pid: Number(match[1]),
      ppid: Number(match[2]),
      start: created > 0n ? String(created) : '',
      startMs: created > 0n ? filetimeToMs(created) : Number.NaN,
      ...(image ? { image } : {}),
      cpuMs: cpu,
    });
  }
  return rows;
}

/**
 * `/proc/<pid>/stat`: имя процесса в скобках может содержать пробелы и `)`, поэтому
 * поля считаются после ПОСЛЕДНЕЙ `)`: 3 — state, 4 — ppid, 14/15 — utime/stime (тики),
 * 22 — starttime.
 */
export function parseProcStat(text: string):
  | {
      pid: number;
      ppid: number;
      starttime: string;
      state: string;
      comm: string;
      /** utime + stime в тиках; `null` — поля не числа. */
      cpuTicks: number | null;
    }
  | undefined {
  const close = text.lastIndexOf(')');
  const open = text.indexOf('(');
  if (close < 0 || open < 0) return undefined;
  const pid = Number(text.slice(0, open).trim());
  const comm = text.slice(open + 1, close);
  const rest = text
    .slice(close + 2)
    .trim()
    .split(/\s+/);
  // rest[0] — поле 3 (state); поле N → rest[N - 3].
  const ppid = Number(rest[1]);
  const starttime = rest[19];
  if (!Number.isInteger(pid) || !Number.isInteger(ppid) || !starttime || !/^\d+$/.test(starttime)) {
    return undefined;
  }
  const utime = rest[11] ?? '';
  const stime = rest[12] ?? '';
  const cpuTicks =
    /^\d+$/.test(utime) && /^\d+$/.test(stime) ? Number(utime) + Number(stime) : null;
  return { pid, ppid, starttime, state: rest[0] ?? '', comm, cpuTicks };
}

/** `btime <сек>` из `/proc/stat`. */
export function parseBootTime(procStat: string): number | undefined {
  const match = /^btime\s+(\d+)$/m.exec(procStat);
  return match ? Number(match[1]) : undefined;
}

export function readLinuxTable(proc = '/proc'): Fact<ProcessRow[]> {
  try {
    const btime = parseBootTime(readFileSync(`${proc}/stat`, 'utf8'));
    if (btime === undefined) return { unknown: `${proc}/stat has no btime` };
    let bootId = 'boot';
    try {
      bootId =
        readFileSync(`${proc}/sys/kernel/random/boot_id`, 'utf8').trim().slice(0, 8) || bootId;
    } catch {
      // Без boot_id (контейнер с урезанным /proc) — точность та же в пределах загрузки.
    }
    const rows: ProcessRow[] = [];
    for (const entry of readdirSync(proc)) {
      if (!/^\d+$/.test(entry)) continue;
      let stat: string;
      try {
        stat = readFileSync(`${proc}/${entry}/stat`, 'utf8');
      } catch {
        continue; // процесс вышел между readdir и чтением
      }
      const parsed = parseProcStat(stat);
      if (!parsed) continue;
      rows.push({
        pid: parsed.pid,
        ppid: parsed.ppid,
        start: `${bootId}:${parsed.starttime}`,
        startMs: btime * 1000 + (Number(parsed.starttime) * 1000) / LINUX_CLK_TCK,
        ...(parsed.state === 'Z' || parsed.state === 'X' ? { zombie: true } : {}),
        ...(parsed.comm ? { image: parsed.comm } : {}),
        cpuMs: parsed.cpuTicks === null ? null : (parsed.cpuTicks * 1000) / LINUX_CLK_TCK,
      });
    }
    return { value: rows };
  } catch (error) {
    return { unknown: reasonOf(error) };
  }
}

/** `pid ppid stat [time] lstart ucomm`: `time` начинается с цифры, `lstart` — с имени дня. */
const LSTART =
  /^\s*(\d+)\s+(\d+)\s+(\S+)\s+(?:(\d[\d:.-]*)\s+)?(\w{3}\s+\w{3}\s+\d{1,2}\s+\d{2}:\d{2}:\d{2}\s+\d{4})\s?(.*)$/;

/**
 * `ps -o time=` — накопленный процессор (user + system): BSD `[[dd-]hh:]mm:ss.cc` (минуты могут
 * быть больше 59), procps `[dd-]hh:mm:ss`. Не разобрано — `null`, не ноль.
 */
export function parsePsTime(text: string): number | null {
  const match = /^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+)(?:\.(\d+))?$/.exec(text.trim());
  if (!match) return null;
  const [days, hours, minutes, seconds] = [1, 2, 3, 4].map((i) => Number(match[i] ?? '0')) as [
    number,
    number,
    number,
    number,
  ];
  const frac = match[5] ? Number(`0.${match[5]}`) : 0;
  return Math.round((((days * 24 + hours) * 60 + minutes) * 60 + seconds + frac) * 1000);
}

function nameHash(command: string): string {
  return createHash('sha1').update(command.trim()).digest('hex').slice(0, 8);
}

/** Аргументы `ps`: у BSD `ps` каждое поле — отдельный `-o` (иначе `=` съедает хвост списка). */
export const DARWIN_PS_ARGS = [
  '-A',
  '-ww',
  '-o',
  'pid=',
  '-o',
  'ppid=',
  '-o',
  'stat=',
  '-o',
  'time=',
  '-o',
  'lstart=',
  '-o',
  'ucomm=',
];

/**
 * Вывод `ps` с `DARWIN_PS_ARGS` под `LC_ALL=C`: `lstart` — местное время вида
 * `Wed Oct 28 10:15:32 2026`; разбор как местного времени — тот же часовой пояс, что у
 * `ps`, потому что оба читают его из окружения этого процесса. `stat` с `Z` — зомби. Столбец
 * `time` (процессор) — до `lstart`; вывод без него (записанный до этапа 8) читается, `cpuMs: null`.
 */
export function parseDarwinPs(text: string): ProcessRow[] {
  const rows: ProcessRow[] = [];
  for (const line of text.split(/\r?\n/)) {
    const match = LSTART.exec(line);
    if (!match) continue;
    const ms = Date.parse((match[5] ?? '').replace(/\s+/g, ' '));
    if (!Number.isFinite(ms)) continue;
    const seconds = Math.floor(ms / 1000);
    const image = (match[6] ?? '').trim();
    rows.push({
      pid: Number(match[1]),
      ppid: Number(match[2]),
      start: `${seconds}:${nameHash(match[6] ?? '')}`,
      startMs: ms,
      ...((match[3] ?? '').startsWith('Z') ? { zombie: true } : {}),
      ...(image ? { image } : {}),
      cpuMs: match[4] === undefined ? null : parsePsTime(match[4]),
    });
  }
  return rows;
}

async function readWindowsTable(): Promise<Fact<ProcessRow[]>> {
  const run = await runWinHelper('table');
  if (!run.ok) return { unknown: `process snapshot: ${run.reason}` };
  const rows = parseWinTable(run.stdout);
  return rows.length > 0 ? { value: rows } : { unknown: 'process snapshot is empty' };
}

async function readDarwinTable(): Promise<Fact<ProcessRow[]>> {
  const run = await runTool('ps', DARWIN_PS_ARGS, { env: { ...process.env, LC_ALL: 'C' } });
  if (!run.ok) return { unknown: `ps: ${run.reason}` };
  const rows = parseDarwinPs(run.stdout);
  return rows.length > 0 ? { value: rows } : { unknown: 'ps printed no rows' };
}

/** Источник настоящей таблицы этой ОС. */
export function osProcessTable(os: OsKind = currentOs()): ProcessTableSource {
  if (os === 'win32') return { read: readWindowsTable };
  if (os === 'darwin') return { read: readDarwinTable };
  return { read: async () => readLinuxTable() };
}
