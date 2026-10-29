import { describe, expect, it } from 'vitest';
import { peerFromTable } from './peer-pid.ts';
import type { TcpEntry } from './tcp-table.ts';

const row = (over: Partial<TcpEntry>): TcpEntry => ({
  state: 'established',
  localAddress: '127.0.0.1',
  localPort: 50000,
  remoteAddress: '127.0.0.1',
  remotePort: 5178,
  ...over,
});

describe('F-16 peer pid — a client row is matched by both endpoints, ambiguity is unknown', () => {
  it('F-16 a non-loopback row with the same port numbers never wins, whatever the row order', () => {
    const rows = [
      row({ localAddress: '192.168.1.5', remoteAddress: '10.0.0.9', pid: 111 }),
      row({ pid: 4242 }),
    ];
    const query = { serverPort: 5178, clientPort: 50000 };
    expect(peerFromTable(rows, query)).toEqual({ value: 4242 });
    expect(peerFromTable([...rows].reverse(), query)).toEqual({ value: 4242 });
  });

  it('F-16 two loopback client rows with the same ports and different owners → unknown, not the first pid', () => {
    const rows = [row({ pid: 111 }), row({ localAddress: '::1', remoteAddress: '::1', pid: 4242 })];
    expect(peerFromTable(rows, { serverPort: 5178, clientPort: 50000 })).toMatchObject({
      unknown: expect.stringContaining('ambiguous'),
    });
  });

  it('F-16 addresses given by the socket pick the exact row; IPv4-mapped spelling equals the IPv4 one', () => {
    const rows = [row({ pid: 111 }), row({ localAddress: '::1', remoteAddress: '::1', pid: 4242 })];
    expect(
      peerFromTable(rows, {
        serverPort: 5178,
        clientPort: 50000,
        serverAddress: '::1',
        clientAddress: '::1',
      }),
    ).toEqual({ value: 4242 });
    expect(
      peerFromTable(rows, {
        serverPort: 5178,
        clientPort: 50000,
        serverAddress: '::ffff:127.0.0.1',
        clientAddress: '::ffff:127.0.0.1',
      }),
    ).toEqual({ value: 111 });
  });

  it('F-16 the server half of the connection owned by another process than the core → unknown', () => {
    const rows = [row({ pid: 4242 }), row({ localPort: 5178, remotePort: 50000, pid: 999 })];
    expect(
      peerFromTable(rows, { serverPort: 5178, clientPort: 50000, serverPid: 777 }),
    ).toMatchObject({ unknown: expect.stringContaining('server row') });
    expect(
      peerFromTable([row({ pid: 4242 }), row({ localPort: 5178, remotePort: 50000, pid: 777 })], {
        serverPort: 5178,
        clientPort: 50000,
        serverPid: 777,
      }),
    ).toEqual({ value: 4242 });
  });
});
