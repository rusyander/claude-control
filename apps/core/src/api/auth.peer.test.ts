import type { IncomingMessage } from 'node:http';
import { describe, expect, it } from 'vitest';
import { peerFromTable, type PeerQuery } from '../platform/peer-pid.ts';
import type { TcpEntry } from '../platform/tcp-table.ts';
import { classifyPeer, type PeerDeps } from './auth.ts';

/**
 * Пир команды через настоящую сверку таблицы TCP (ревью F-16, потребитель): `classifyPeer`
 * обязан назвать платформе оба адреса сокета и pid ядра. По одним портам чужая строка с теми же
 * портами (другой loopback-адрес) приписала бы звонящему чужой pid — сессия стала бы «человеком».
 */

const HUMAN_PID = 4242;
const SESSION_PID = 6666;
const CORE_PORT = 5190;
const CLIENT_PORT = 50_000;

function request(remoteAddress = '127.0.0.1', localAddress = '127.0.0.1'): IncomingMessage {
  return {
    socket: { remoteAddress, localAddress, localPort: CORE_PORT, remotePort: CLIENT_PORT },
    headers: {},
  } as unknown as IncomingMessage;
}

const row = (pid: number, local: [string, number], remote: [string, number]): TcpEntry => ({
  state: 'established',
  localAddress: local[0],
  localPort: local[1],
  remoteAddress: remote[0],
  remotePort: remote[1],
  pid,
});

function deps(rows: TcpEntry[], seen: PeerQuery[] = []): PeerDeps {
  return {
    peerPid: async (query) => {
      seen.push(query as PeerQuery);
      return peerFromTable(rows, query as PeerQuery);
    },
    isSessionDescendant: async (pid) => pid === SESSION_PID,
    trustedHopPids: new Set(),
  };
}

describe('classifyPeer: both ends of the socket reach the TCP table', () => {
  it('F-16 a same-ports row on another loopback address does not make a session caller human', async () => {
    // Строка звонящего (сессия, 127.0.0.1) из снимка выпала; осталась чужая — человек на 127.0.0.2.
    const rows = [row(HUMAN_PID, ['127.0.0.2', CLIENT_PORT], ['127.0.0.2', CORE_PORT])];
    expect(await classifyPeer(request(), deps(rows))).toBe('unknown');
  });

  it('F-16 IPv4 and IPv6 rows with the same ports: the socket address picks the caller, not the row order', async () => {
    const rows = [
      row(SESSION_PID, ['::1', CLIENT_PORT], ['::1', CORE_PORT]),
      row(HUMAN_PID, ['127.0.0.1', CLIENT_PORT], ['127.0.0.1', CORE_PORT]),
    ];
    expect(await classifyPeer(request('::1', '::1'), deps(rows))).toBe('session-descendant');
    expect(await classifyPeer(request('::ffff:127.0.0.1', '::ffff:127.0.0.1'), deps(rows))).toBe(
      'clear',
    );
  });

  it('F-16 the query carries the socket addresses and the core pid; a server half owned by another pid is unknown', async () => {
    const seen: PeerQuery[] = [];
    const rows = [
      row(HUMAN_PID, ['127.0.0.1', CLIENT_PORT], ['127.0.0.1', CORE_PORT]),
      row(process.pid + 1, ['127.0.0.1', CORE_PORT], ['127.0.0.1', CLIENT_PORT]),
    ];
    expect(await classifyPeer(request(), deps(rows, seen))).toBe('unknown');
    expect(seen[0]).toEqual({
      serverPort: CORE_PORT,
      clientPort: CLIENT_PORT,
      serverAddress: '127.0.0.1',
      clientAddress: '127.0.0.1',
      serverPid: process.pid,
    });
  });
});
