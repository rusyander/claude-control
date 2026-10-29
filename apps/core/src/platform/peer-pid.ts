import { currentOs, hasValue, type OsKind } from './os-kind.ts';
import { readTcpTable, type TcpEntry } from './tcp-table.ts';
import type { Fact } from './os-kind.ts';

/**
 * Номер процесса на том конце loopback-соединения с ядром (P107, 06 §Authority): модель
 * может подделать заголовки и прочитать токен, но не номер своего процесса — ядро
 * спрашивает ОС, кому принадлежит сокет клиента.
 *
 * Соединение видно в таблице дважды: строкой сервера (local = порт ядра) и строкой
 * клиента (local = эфемерный порт клиента, remote = порт ядра). Владелец клиентской
 * строки — ответ. Не нашлось или ОС не ответила — `unknown`: решение тогда опирается
 * только на подпись устройства (06), никогда не считает звонящего «человеком».
 */

export interface PeerQuery {
  /** Порт, на котором ядро приняло соединение (`socket.localPort`). */
  serverPort: number;
  /** Порт клиента (`socket.remotePort`). */
  clientPort: number;
  /** Адрес ядра в этом соединении (`socket.localAddress`); есть — строка сверяется и по нему. */
  serverAddress?: string;
  /** Адрес клиента (`socket.remoteAddress`). */
  clientAddress?: string;
  /** pid ядра: серверная половина соединения обязана принадлежать ему (F-16). */
  serverPid?: number;
}

const LOOPBACK_V4 = /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/;

/** Одно написание адреса: `::ffff:127.0.0.1` (двойной стек) и `127.0.0.1` — один адрес. */
export function normalizeAddress(address: string): string {
  const lower = address
    .trim()
    .toLowerCase()
    .replace(/^\[|\]$/g, '');
  return lower.startsWith('::ffff:') && LOOPBACK_V4.test(lower.slice(7)) ? lower.slice(7) : lower;
}

function isLoopback(address: string): boolean {
  const norm = normalizeAddress(address);
  return norm === '::1' || LOOPBACK_V4.test(norm);
}

/**
 * Строка соединения сверяется по ОБОИМ концам (F-16): порты совпадают и у чужого соединения
 * (тот же эфемерный порт на другом адресе, IPv4 и IPv6 разом), поэтому учитываются только
 * loopback-строки, адреса — когда их назвал сокет, а несколько разных владельцев — `unknown`,
 * никогда не «первый попавшийся». Серверная половина, если видна, должна быть ядра.
 */
export function peerFromTable(rows: readonly TcpEntry[], query: PeerQuery): Fact<number> {
  const server =
    query.serverAddress === undefined ? undefined : normalizeAddress(query.serverAddress);
  const client =
    query.clientAddress === undefined ? undefined : normalizeAddress(query.clientAddress);
  const half = (entry: TcpEntry, local: number, remote: number, la?: string, ra?: string) =>
    entry.state === 'established' &&
    entry.localPort === local &&
    entry.remotePort === remote &&
    isLoopback(entry.localAddress) &&
    isLoopback(entry.remoteAddress) &&
    (la === undefined || normalizeAddress(entry.localAddress) === la) &&
    (ra === undefined || normalizeAddress(entry.remoteAddress) === ra);
  const clientRows = rows.filter((entry) =>
    half(entry, query.clientPort, query.serverPort, client, server),
  );
  const pid = clientRows[0]?.pid;
  if (clientRows.length === 0)
    return { unknown: `no client row ${query.clientPort} → ${query.serverPort}` };
  if (pid === undefined || clientRows.some((row) => row.pid === undefined))
    return { unknown: 'owner not exposed by the OS' };
  const owners = new Set(clientRows.map((row) => row.pid));
  if (owners.size > 1)
    return { unknown: `ambiguous client rows ${query.clientPort} → ${query.serverPort}` };
  if (query.serverPid !== undefined) {
    const serverRows = rows.filter((entry) =>
      half(entry, query.serverPort, query.clientPort, server, client),
    );
    const foreign = serverRows.find((row) => row.pid !== undefined && row.pid !== query.serverPid);
    if (foreign) return { unknown: `server row owned by pid ${foreign.pid}, not the core` };
  }
  return { value: pid };
}

export async function peerPid(
  query: PeerQuery,
  os: OsKind = currentOs(),
  read: (os: OsKind) => Promise<Fact<TcpEntry[]>> = readTcpTable,
): Promise<Fact<number>> {
  const table = await read(os);
  if (!hasValue(table)) return { unknown: 'unknown' in table ? table.unknown : 'tcp table absent' };
  return peerFromTable(table.value, query);
}
