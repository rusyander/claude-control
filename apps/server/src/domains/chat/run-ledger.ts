import { existsSync, readFileSync } from 'node:fs';
import { execFile, spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { writeJsonFile } from '../../lib/safe-io.ts';

/**
 * Журнал идущих прогонов на диске — чтобы реестр пережил перезапуск панели.
 *
 * Реестр прогонов живёт в памяти сервера, а процессы CLI — нет: `node --watch`
 * на Windows убивает сервер без обработчиков, и агенты остаются жить сиротами.
 * До этого журнала каждый их запрос прав после перезапуска встречал пустой
 * реестр и получал «Разговор не найден» — 09.09.2026 так отказали 24 вызовам в
 * двух прогонах за одну секунду, а 03.09 — ещё 28. Здесь лежит ровно то, что
 * нужно, чтобы на старте УСЫНОВИТЬ живой процесс: ключ, под которым его знает
 * брокер прав, второе написание ключа (sessionId), pid, каталог и то, с чем
 * прогон стартовал.
 *
 * Свой файл, а не `state.json`, по той же причине, что и журнал понижённых
 * прогонов: запись на каждый старт и каждое завершение, и битый файл здесь
 * значит «усыновлять некого», а не панель без настроек.
 */

/** Положение тумблеров прогона — в памяти `ChatSession`, сюда попадает снимком. */
export interface LedgerAutoApprove {
  enabled: boolean;
  allowEdits: boolean;
}

export interface RunLedgerEntry {
  /** Ключ реестра — тот же, что брокер прав получает в `PERM_RUN_ID`. */
  key: string;
  /** Второе написание ключа: настоящий `sessionId`, когда CLI его уже назвал. */
  sessionId?: string;
  projectPath?: string;
  /** Рабочая папка прогона: без неё усыновлённый прогон не остановить осмысленно. */
  cwd: string;
  /** PID запущенного процесса (на Windows — оболочки `cmd.exe`, которая ждёт CLI). */
  pid?: number;
  startedAt: number;
  model?: string;
  effort?: string;
  /** Понижение прогона — тем же составом, что `RunMeta.lowered` (сюда без импорта: цикл). */
  lowered?: { model: string; effort: string; kind?: string };
  /**
   * Снимок тумблеров автоподтверждения. Без него усыновлённый прогон спрашивал бы
   * человека о каждом вызове — ровно там, где до перезапуска молчал.
   */
  autoApprove?: LedgerAutoApprove;
}

/** Сколько записей держим. Строка на прогон; больше сотни живых прогонов не бывает. */
const LIMIT = 100;

/**
 * Старше этого запись не усыновляем, даже если pid жив: за сутки система успевает
 * выдать тот же номер другому процессу, а убить чужое по кнопке «Остановить» —
 * хуже, чем не подхватить своё.
 */
export const MAX_AGE_MS = 24 * 60 * 60 * 1000;

/**
 * Отказ брокера прав прогону, которого нет ни в реестре, ни в журнале. Текст
 * уезжает агенту как результат вызова — и в транскрипт, откуда его показывает
 * лента: это и есть системная заметка о случившемся.
 */
export const RUN_UNKNOWN_DENIED =
  'Панель перезапускалась, прогон не в реестре — отправьте сообщение заново.';

/**
 * `file` — имя файла журнала: у процессов агента панели свой файл
 * (`panel-agent/processes.ts`), иначе реестр чата усыновил бы их как прогоны чата.
 */
export function ledgerPath(appDataDir: string, file = 'runs.json'): string {
  return join(appDataDir, file);
}

/** Прочитать журнал. Битый или отсутствующий файл — пустой журнал, без крика. */
export function readRunLedger(appDataDir: string, file?: string): RunLedgerEntry[] {
  const path = ledgerPath(appDataDir, file);
  if (!existsSync(path)) return [];
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isEntry);
  } catch {
    return [];
  }
}

function isEntry(value: unknown): value is RunLedgerEntry {
  if (!value || typeof value !== 'object') return false;
  const entry = value as Record<string, unknown>;
  return (
    typeof entry.key === 'string' &&
    entry.key.length > 0 &&
    typeof entry.cwd === 'string' &&
    typeof entry.startedAt === 'number'
  );
}

/**
 * Журнал как объект: реестр пишет через него, не зная про каталоги, а bootstrap
 * читает на старте. Каждая операция перечитывает файл — записей единицы, а
 * держать вторую копию правды в памяти значило бы разойтись с диском после
 * первого же сбоя записи.
 */
export class RunLedger {
  private readonly appDataDir: string;
  private readonly file: string | undefined;

  constructor(appDataDir: string, file?: string) {
    this.appDataDir = appDataDir;
    this.file = file;
  }

  read(): RunLedgerEntry[] {
    return readRunLedger(this.appDataDir, this.file);
  }

  /** Записать или обновить запись по ключу; свежие — в конце. */
  upsert(entry: RunLedgerEntry): void {
    const rest = this.read().filter((item) => item.key !== entry.key);
    this.write([...rest, entry].slice(-LIMIT));
  }

  remove(key: string): void {
    const current = this.read();
    const next = current.filter((item) => item.key !== key);
    if (next.length !== current.length) this.write(next);
  }

  private write(entries: RunLedgerEntry[]): void {
    try {
      writeJsonFile(ledgerPath(this.appDataDir, this.file), entries);
    } catch {
      // Журнал — страховка, а не часть работы прогона: отказ диска не должен
      // ронять ни запуск, ни завершение.
    }
  }
}

/**
 * Жив ли процесс. Сигнал 0 ничего не шлёт — только проверяет существование;
 * `EPERM` значит «есть, но не наш» — для усыновления это тоже «жив».
 */
export function isPidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/**
 * Имена процессов, под которыми живёт запущенный панелью CLI: на Windows `spawn`
 * с оболочкой отдаёт pid `cmd.exe`, на POSIX — `sh`/`node`/сам `claude`.
 */
const CLI_IMAGE = /^(cmd|cmd\.exe|sh|bash|zsh|node|node\.exe|claude|claude\.exe|claude\.cmd)$/i;

/**
 * Похож ли процесс с этим pid на запущенный панелью CLI. Страховка от переданного
 * другому процессу номера: усыновить чужое — значит потом убить его по кнопке.
 * Не смогли спросить систему — верим pid: не подхватить своё дороже.
 */
export function pidLooksLikeCli(pid: number): boolean {
  try {
    const name =
      process.platform === 'win32'
        ? imageNameWindows(pid)
        : spawnSync('ps', ['-o', 'comm=', '-p', String(pid)], { encoding: 'utf8' }).stdout;
    const short = (name ?? '').trim().split(/[\\/]/).pop() ?? '';
    if (!short) return true;
    return CLI_IMAGE.test(short);
  } catch {
    return true;
  }
}

function imageNameWindows(pid: number): string {
  const out = spawnSync('tasklist', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'], {
    encoding: 'utf8',
    windowsHide: true,
  }).stdout;
  // Строка CSV: "cmd.exe","248736","Console","1","5 000 K". Нет строки в кавычках
  // — процесса нет или фильтр не сработал; отдаём пусто, и pid берётся на веру.
  const match = /^"([^"]+)"/.exec((out ?? '').trim());
  return match?.[1] ?? '';
}

/**
 * Какие записи журнала стоит усыновлять: живой и похожий на CLI pid, не старше
 * суток. Остальное — след завершившихся прогонов, его вычищаем.
 */
export function adoptableEntries(
  entries: RunLedgerEntry[],
  probe: { isAlive: (pid: number) => boolean; looksLikeCli: (pid: number) => boolean },
  now = Date.now(),
): { adopt: RunLedgerEntry[]; drop: RunLedgerEntry[] } {
  const adopt: RunLedgerEntry[] = [];
  const drop: RunLedgerEntry[] = [];
  for (const entry of entries) {
    const fresh = now - entry.startedAt <= MAX_AGE_MS;
    const alive = entry.pid !== undefined && fresh && probe.isAlive(entry.pid);
    if (alive && probe.looksLikeCli(entry.pid as number)) adopt.push(entry);
    else drop.push(entry);
  }
  return { adopt, drop };
}

/** Что известно о дочернем процессе: номер и имя образа. */
export interface ChildProcessInfo {
  pid: number;
  name: string;
}

/**
 * Имя процесса самого CLI под обёрткой: `claude.exe` (родной бинарник) или
 * `node` (пакетный запуск). `conhost.exe` и вложенные `cmd.exe` — не он.
 */
const CLI_CHILD = /^(claude|claude\.exe|node|node\.exe)$/i;

/**
 * Дети процесса на Windows. `wmic` на свежих сборках нет, у `tasklist` нет
 * фильтра по родителю — остаётся CIM через PowerShell (~0,8 с, поэтому только
 * асинхронно и никогда на пути запроса).
 */
export function listChildProcesses(pid: number): Promise<ChildProcessInfo[]> {
  const script =
    `Get-CimInstance -ClassName Win32_Process -Filter "ParentProcessId = ${pid}" | ` +
    'ForEach-Object { $_.ProcessId.ToString() + " " + $_.Name }';
  return new Promise((resolve) => {
    execFile(
      'powershell',
      ['-NoProfile', '-NonInteractive', '-Command', script],
      { windowsHide: true, timeout: 8000, encoding: 'utf8' },
      (error, stdout) => {
        if (error) return resolve([]);
        const children: ChildProcessInfo[] = [];
        for (const line of String(stdout).split(/\r?\n/)) {
          const match = /^(\d+)\s+(\S+)/.exec(line.trim());
          if (match) children.push({ pid: Number(match[1]), name: match[2] ?? '' });
        }
        resolve(children);
      },
    );
  });
}

/** Среди детей обёртки — сам CLI, если он там есть. */
export function pickCliChild(children: ChildProcessInfo[]): number | undefined {
  return children.find((child) => CLI_CHILD.test(child.name))?.pid;
}

export interface ResolveCliPidDeps {
  list?: (pid: number) => Promise<ChildProcessInfo[]>;
  attempts?: number;
  delayMs?: number;
}

/**
 * Номер процесса, который стоит писать в журнал.
 *
 * На Windows `spawn` через оболочку отдаёт pid `cmd.exe`, а перезапуск
 * сервера (`node --watch`) убивает ровно эту обёртку: `claude.exe` под ней
 * живёт дальше сиротой, но по номеру обёртки он уже «мёртв», и усыновлять
 * после перезапуска было некого — проверено 09.09.2026 живой пробой. Поэтому в
 * журнал идёт pid самого CLI: его ищем среди детей обёртки, с парой повторов —
 * бинарник появляется под `cmd.exe` не мгновенно. Не нашли — остаётся обёртка.
 * Вне Windows обёртки нет, номер и так верный.
 */
export async function resolveCliPid(
  wrapperPid: number,
  deps: ResolveCliPidDeps = {},
): Promise<number> {
  const list = deps.list ?? (process.platform === 'win32' ? listChildProcesses : undefined);
  if (!list) return wrapperPid;
  const attempts = deps.attempts ?? 3;
  const delayMs = deps.delayMs ?? 700;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const found = pickCliChild(await list(wrapperPid));
    if (found !== undefined) return found;
    if (attempt + 1 < attempts) await new Promise((resolve) => setTimeout(resolve, delayMs));
  }
  return wrapperPid;
}
