import { execFile } from 'node:child_process';
import { readFileSync, readdirSync, readlinkSync } from 'node:fs';
import type { ProcessRow } from '../kill-tree.mjs';

/**
 * Чей процесс на том конце TCP-соединения с этим сервером — и чей он потомок.
 *
 * Зачем. Маршруты решений человека (права, отложенные вопросы D-n, ворота
 * ветки) слушают loopback, а у модели в прогоне есть `curl` и `node`: пустой
 * Origin проходит сторож источника, ключ `~/.agentdeck/api-token` модели
 * читаем. Единственное, что модель подделать не может, — номер своего
 * процесса: ядро знает, кому принадлежит сокет на том конце. Здесь — только
 * факты ОС, без знания о прогонах (`lib/` не знает реестра).
 *
 * Windows — `netstat -ano` (единственный способ без сторонних утилит), Linux —
 * `/proc/net/tcp{,6}` → inode → `/proc/<pid>/fd`, macOS — `lsof`.
 */

export interface TcpRow {
  localPort: number;
  remotePort: number;
  /** Владелец сокета; `undefined` — ОС не сказала (Linux без доступа к чужим `fd`). */
  pid?: number;
}

export type Exec = (command: string, args: readonly string[]) => Promise<string | undefined>;

const EXEC_TIMEOUT_MS = 8_000;

export const execText: Exec = (command, args) =>
  new Promise((done) => {
    try {
      execFile(
        command,
        [...args],
        {
          encoding: 'utf8',
          windowsHide: true,
          timeout: EXEC_TIMEOUT_MS,
          maxBuffer: 32 * 1024 * 1024,
        },
        (error, stdout) => done(error ? undefined : String(stdout)),
      );
    } catch {
      done(undefined);
    }
  });

function portOf(endpoint: string): number | undefined {
  const match = /:(\d+)$/.exec(endpoint.trim());
  const port = match ? Number(match[1]) : NaN;
  return Number.isInteger(port) && port > 0 && port < 65_536 ? port : undefined;
}

/** `netstat -ano`: `TCP  127.0.0.1:54321  127.0.0.1:5178  ESTABLISHED  1234` (и `[::1]:…`). */
export function parseNetstat(text: string): TcpRow[] {
  const rows: TcpRow[] = [];
  for (const line of text.split(/\r?\n/)) {
    const parts = line.trim().split(/\s+/);
    if (parts.length < 5 || !/^TCP/i.test(parts[0] ?? '')) continue;
    const localPort = portOf(parts[1] ?? '');
    const remotePort = portOf(parts[2] ?? '');
    const pid = Number(parts[4]);
    if (localPort === undefined || remotePort === undefined) continue;
    rows.push({ localPort, remotePort, ...(Number.isInteger(pid) && pid > 0 ? { pid } : {}) });
  }
  return rows;
}

/** `lsof -nP -iTCP -sTCP:ESTABLISHED -Fpn`: строки `p<pid>` и `n<local>-><remote>`. */
export function parseLsof(text: string): TcpRow[] {
  const rows: TcpRow[] = [];
  let pid: number | undefined;
  for (const line of text.split(/\r?\n/)) {
    if (line.startsWith('p')) pid = Number(line.slice(1)) || undefined;
    if (!line.startsWith('n') || !line.includes('->')) continue;
    const [local, remote] = line.slice(1).split('->');
    const localPort = portOf(local ?? '');
    const remotePort = portOf(remote ?? '');
    if (localPort === undefined || remotePort === undefined) continue;
    rows.push({ localPort, remotePort, ...(pid ? { pid } : {}) });
  }
  return rows;
}

/** `/proc/net/tcp`: `sl local rem st … inode` — адреса в hex, порт после двоеточия. */
export function parseProcNet(
  text: string,
): { localPort: number; remotePort: number; inode: string }[] {
  const rows: { localPort: number; remotePort: number; inode: string }[] = [];
  for (const line of text.split(/\r?\n/).slice(1)) {
    const parts = line.trim().split(/\s+/);
    if (parts.length < 10) continue;
    const localPort = parseInt((parts[1] ?? '').split(':')[1] ?? '', 16);
    const remotePort = parseInt((parts[2] ?? '').split(':')[1] ?? '', 16);
    const inode = parts[9] ?? '';
    if (!localPort || !remotePort || !inode || inode === '0') continue;
    rows.push({ localPort, remotePort, inode });
  }
  return rows;
}

function linuxRows(wanted: ReadonlySet<number>, proc = '/proc'): TcpRow[] {
  const sockets: { localPort: number; remotePort: number; inode: string }[] = [];
  for (const name of ['tcp', 'tcp6']) {
    try {
      sockets.push(...parseProcNet(readFileSync(`${proc}/net/${name}`, 'utf8')));
    } catch {
      // Нет таблицы (без IPv6) — смотрим вторую.
    }
  }
  const needed = sockets.filter((row) => wanted.has(row.localPort));
  const owner = new Map<string, number>();
  if (needed.length > 0) {
    const inodes = new Set(needed.map((row) => `socket:[${row.inode}]`));
    for (const entry of readdirSync(proc)) {
      if (!/^\d+$/.test(entry)) continue;
      let fds: string[];
      try {
        fds = readdirSync(`${proc}/${entry}/fd`);
      } catch {
        continue;
      }
      for (const fd of fds) {
        try {
          const target = readlinkSync(`${proc}/${entry}/fd/${fd}`);
          if (inodes.has(target)) owner.set(target.slice(8, -1), Number(entry));
        } catch {
          // Процесс ушёл между чтениями.
        }
      }
    }
  }
  return sockets.map((row) => {
    const pid = owner.get(row.inode);
    return { localPort: row.localPort, remotePort: row.remotePort, ...(pid ? { pid } : {}) };
  });
}

/**
 * Таблица TCP-соединений с владельцами. `wanted` — локальные порты, чьи
 * владельцы нужны (Linux ищет владельца перебором `fd`, и только для них).
 * `undefined` — ОС не ответила: вызывающий обязан отказать, а не пропустить.
 */
export async function readTcpTable(
  wanted: ReadonlySet<number>,
  platform: string = process.platform,
  exec: Exec = execText,
): Promise<TcpRow[] | undefined> {
  if (platform === 'win32') {
    const text = await exec('netstat', ['-ano']);
    return text === undefined ? undefined : parseNetstat(text);
  }
  if (platform === 'darwin') {
    const text = await exec('lsof', ['-nP', '-iTCP', '-sTCP:ESTABLISHED', '-Fpn']);
    return text === undefined ? undefined : parseLsof(text);
  }
  try {
    return linuxRows(wanted);
  } catch {
    return undefined;
  }
}

/** Владелец конца соединения: локальный порт `localPort`, порт той стороны `remotePort`. */
export function ownerOf(
  rows: readonly TcpRow[],
  localPort: number,
  remotePort: number,
): number | undefined {
  return rows.find((row) => row.localPort === localPort && row.remotePort === remotePort)?.pid;
}

/**
 * Предки процесса, сам он первым. Номер, созданный ПОЗЖЕ ребёнка, — чужой
 * процесс на освободившемся номере родителя (Windows не чистит ppid): на нём
 * цепочка обрывается, иначе родителем считался бы случайный процесс.
 */
export function ancestorsOf(table: readonly ProcessRow[], pid: number, limit = 64): number[] {
  return ancestryOf(table, pid, limit).chain;
}

/**
 * Предки процесса и ЧЕМ кончился обход. `complete: false` — цепочка оборвалась:
 * родителя нет в таблице (процесс отвязался от своего дерева — `setsid`,
 * `start /b`, двойной `fork`), номер родителя занял более новый процесс
 * (pid-reuse), или обход упёрся в потолок. Для решения человека это важнее
 * самой цепочки: «предков не видно» — не повод считать звонящего человеком
 * (D-S01).
 */
export interface Ancestry {
  /** Сам процесс первым, затем предки. */
  chain: number[];
  /** Обход дошёл до корня дерева, а не оборвался. */
  complete: boolean;
}

export function ancestryOf(table: readonly ProcessRow[], pid: number, limit = 64): Ancestry {
  const byPid = new Map(table.map((row) => [row.pid, row]));
  const chain: number[] = [];
  let current = byPid.get(pid);
  // Процесса уже нет в таблице — судить нечего.
  if (!current) return { chain: [pid], complete: false };
  const seen = new Set<number>();
  while (chain.length < limit) {
    chain.push(current.pid);
    seen.add(current.pid);
    // Корень дерева: `System Idle Process` (0) на Windows, `init`/`launchd` (1).
    if (current.ppid === 0 || current.ppid === current.pid || current.pid === 1) {
      return { chain, complete: true };
    }
    const parent = byPid.get(current.ppid);
    if (!parent || seen.has(parent.pid)) return { chain, complete: false };
    if (parent.created > 0n && current.created > 0n && parent.created > current.created) {
      return { chain, complete: false };
    }
    current = parent;
  }
  return { chain, complete: false };
}
