import { readFileSync, readdirSync, readlinkSync } from 'node:fs';
import { currentOs, reasonOf, type Fact, type OsKind } from './os-kind.ts';
import { runTool } from './run-tool.ts';
import { runWinHelper } from './win-helper.ts';

/**
 * Таблица TCP с владельцами (09 §ports, §peer pid; 01 §Resources): кто слушает порт и
 * чей процесс на том конце loopback-соединения. Windows — `GetExtendedTcpTable` через
 * помощник (одним вызовом IPv4 + IPv6); Linux — `/proc/net/tcp{,6}` + inode сокета →
 * `/proc/<pid>/fd`; macOS — `lsof -nP -iTCP -FpnT`. Нет ответа ОС — `unknown`, никогда
 * не пустая таблица (пустая значила бы «никто не слушает» — ложное «чисто»).
 */

export type TcpState = 'listen' | 'established' | 'other';

export interface TcpEntry {
  state: TcpState;
  localAddress: string;
  localPort: number;
  remoteAddress: string;
  remotePort: number;
  /** Владелец; `undefined` — ОС не сказала (Linux: чужой процесс, нет доступа к `fd`). */
  pid?: number;
}

/** Состояния MIB_TCP_STATE: 2 — LISTEN, 5 — ESTABLISHED. */
export function parseWinTcp(text: string): TcpEntry[] {
  const rows: TcpEntry[] = [];
  for (const line of text.split(/\r?\n/)) {
    const parts = line.trim().split(' ');
    if (parts.length !== 6) continue;
    const [state, la, lp, ra, rp, pid] = parts;
    const code = Number(state);
    rows.push({
      state: code === 2 ? 'listen' : code === 5 ? 'established' : 'other',
      localAddress: la ?? '',
      localPort: Number(lp),
      remoteAddress: ra ?? '',
      remotePort: Number(rp),
      ...(Number(pid) > 0 ? { pid: Number(pid) } : {}),
    });
  }
  return rows;
}

function hexIpv4(hex: string): string {
  // Слово в порядке байт хоста (little-endian): `0100007F` → 127.0.0.1.
  const bytes = [6, 4, 2, 0].map((at) => parseInt(hex.slice(at, at + 2), 16));
  return bytes.join('.');
}

function hexIpv6(hex: string): string {
  const groups: string[] = [];
  for (let word = 0; word < 4; word += 1) {
    const chunk = hex.slice(word * 8, word * 8 + 8);
    const le = [6, 4, 2, 0].map((at) => chunk.slice(at, at + 2)).join('');
    groups.push(le.slice(0, 4), le.slice(4, 8));
  }
  const text = groups.map((g) => g.replace(/^0+(?=.)/, '').toLowerCase()).join(':');
  if (text === '0:0:0:0:0:0:0:1') return '::1';
  if (text === '0:0:0:0:0:0:0:0') return '::';
  return text;
}

/** `/proc/net/tcp{,6}`: `sl local rem st … inode`; состояние `0A` — LISTEN, `01` — ESTABLISHED. */
export function parseProcNetTcp(text: string): (Omit<TcpEntry, 'pid'> & { inode: string })[] {
  const rows: (Omit<TcpEntry, 'pid'> & { inode: string })[] = [];
  for (const line of text.split(/\r?\n/).slice(1)) {
    const parts = line.trim().split(/\s+/);
    if (parts.length < 10) continue;
    const [lAddr, lPort] = (parts[1] ?? '').split(':');
    const [rAddr, rPort] = (parts[2] ?? '').split(':');
    const decode = (hex: string) => (hex.length > 8 ? hexIpv6(hex) : hexIpv4(hex));
    rows.push({
      state: parts[3] === '0A' ? 'listen' : parts[3] === '01' ? 'established' : 'other',
      localAddress: decode(lAddr ?? ''),
      localPort: parseInt(lPort ?? '', 16),
      remoteAddress: decode(rAddr ?? ''),
      remotePort: parseInt(rPort ?? '', 16),
      inode: parts[9] ?? '0',
    });
  }
  return rows;
}

/** Сокет-inode → номер процесса перебором `/proc/<pid>/fd` (только нужные inode). */
export function socketOwners(inodes: ReadonlySet<string>, proc = '/proc'): Map<string, number> {
  const owners = new Map<string, number>();
  if (inodes.size === 0) return owners;
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
        const inode = /^socket:\[(\d+)\]$/.exec(target)?.[1];
        if (inode && inodes.has(inode)) owners.set(inode, Number(entry));
      } catch {
        // Дескриптор закрылся между чтениями.
      }
    }
  }
  return owners;
}

export function readLinuxTcp(proc = '/proc'): Fact<TcpEntry[]> {
  const sockets: (Omit<TcpEntry, 'pid'> & { inode: string })[] = [];
  // Половина таблицы — не таблица (F-114): «порт свободен» по одной IPv4 при непрочитанной IPv6
  // было бы ложью. Только `tcp6` вправе отсутствовать (ядро без IPv6); иной сбой — `unknown`.
  for (const name of ['tcp', 'tcp6']) {
    try {
      sockets.push(...parseProcNetTcp(readFileSync(`${proc}/net/${name}`, 'utf8')));
    } catch (error) {
      if (name === 'tcp6' && (error as NodeJS.ErrnoException).code === 'ENOENT') continue;
      return { unknown: `${proc}/net/${name} unreadable: ${reasonOf(error)}` };
    }
  }
  try {
    const owners = socketOwners(
      new Set(sockets.map((row) => row.inode).filter((i) => i !== '0')),
      proc,
    );
    return {
      value: sockets.map(({ inode, ...row }) => {
        const pid = owners.get(inode);
        return pid === undefined ? row : { ...row, pid };
      }),
    };
  } catch (error) {
    return { unknown: reasonOf(error) };
  }
}

/** `lsof -nP -iTCP -FpnT`: `p<pid>`, `n<local>[-><remote>]`, `TST=<state>`. */
export function parseLsofTcp(text: string): TcpEntry[] {
  const rows: TcpEntry[] = [];
  let pid: number | undefined;
  let current: TcpEntry | undefined;
  const split = (endpoint: string): [string, number] => {
    const at = endpoint.lastIndexOf(':');
    return [endpoint.slice(0, at).replace(/^\[|\]$/g, ''), Number(endpoint.slice(at + 1))];
  };
  for (const line of text.split(/\r?\n/)) {
    const tag = line[0];
    const body = line.slice(1);
    if (tag === 'p') pid = Number(body) || undefined;
    if (tag === 'n') {
      const [local, remote] = body.split('->');
      const [la, lp] = split(local ?? '');
      const [ra, rp] = remote ? split(remote) : ['', 0];
      current = {
        state: 'other',
        localAddress: la,
        localPort: lp,
        remoteAddress: ra,
        remotePort: rp,
        ...(pid ? { pid } : {}),
      };
      rows.push(current);
    }
    if (tag === 'T' && body.startsWith('ST=') && current) {
      const state = body.slice(3);
      current.state =
        state === 'LISTEN' ? 'listen' : state === 'ESTABLISHED' ? 'established' : 'other';
    }
  }
  return rows.filter((row) => Number.isInteger(row.localPort) && row.localPort > 0);
}

export async function readTcpTable(os: OsKind = currentOs()): Promise<Fact<TcpEntry[]>> {
  if (os === 'win32') {
    const run = await runWinHelper('tcp');
    return run.ok
      ? { value: parseWinTcp(run.stdout) }
      : { unknown: `GetExtendedTcpTable: ${run.reason}` };
  }
  if (os === 'darwin') {
    // lsof выходит с 1, когда совпадений нет, — это пустая таблица, а не сбой.
    const run = await runTool('lsof', ['-nP', '-iTCP', '-FpnT'], { acceptNonZero: true });
    if (!run.ok) return { unknown: `lsof: ${run.reason}` };
    if (run.code !== 0 && run.stderr.trim()) return { unknown: `lsof: ${run.stderr.trim()}` };
    return { value: parseLsofTcp(run.stdout) };
  }
  return readLinuxTcp();
}
