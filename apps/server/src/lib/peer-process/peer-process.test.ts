import { spawn, type ChildProcess } from 'node:child_process';
import { createServer, type Server, type Socket } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { readProcessTableAsync } from '../kill-tree.mjs';
import {
  ancestorsOf,
  ancestryOf,
  ownerOf,
  parseLsof,
  parseNetstat,
  parseProcNet,
  readTcpTable,
} from './peer-process.ts';

const NETSTAT = [
  '',
  'Active Connections',
  '',
  '  Proto  Local Address          Foreign Address        State           PID',
  '  TCP    0.0.0.0:5178           0.0.0.0:0              LISTENING       4100',
  '  TCP    127.0.0.1:5178         127.0.0.1:61001        ESTABLISHED     4100',
  '  TCP    127.0.0.1:61001        127.0.0.1:5178         ESTABLISHED     7300',
  '  TCP    [::1]:8888             [::1]:61002            ESTABLISHED     5200',
  '  UDP    0.0.0.0:5353           *:*                                    900',
].join('\r\n');

describe('peer-process', () => {
  describe('parsers', () => {
    it('netstat: established TCP rows with owner; LISTENING (port 0), UDP and headers skipped', () => {
      const rows = parseNetstat(NETSTAT);
      expect(rows).toHaveLength(3);
      expect(ownerOf(rows, 61001, 5178)).toBe(7300);
      expect(ownerOf(rows, 8888, 61002)).toBe(5200);
      expect(ownerOf(rows, 61001, 9999)).toBeUndefined();
    });

    it('lsof -F: the pid line applies to the following n-lines', () => {
      const rows = parseLsof(
        [
          'p7300',
          'f12',
          'n127.0.0.1:61001->127.0.0.1:5178',
          'p4100',
          'n127.0.0.1:5178->127.0.0.1:61001',
        ].join('\n'),
      );
      expect(ownerOf(rows, 61001, 5178)).toBe(7300);
      expect(ownerOf(rows, 5178, 61001)).toBe(4100);
    });

    it('/proc/net/tcp: hex ports and the inode, inode 0 skipped', () => {
      const text = [
        '  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode',
        '   0: 0100007F:EE49 0100007F:143A 01 00000000:00000000 00:00000000 00000000  1000        0 98765 1',
        '   1: 0100007F:143A 0100007F:EE49 01 00000000:00000000 00:00000000 00000000  1000        0 0 1',
      ].join('\n');
      expect(parseProcNet(text)).toEqual([
        { localPort: 0xee49, remotePort: 0x143a, inode: '98765' },
      ]);
    });

    it('a failing OS command is undefined (the caller must refuse), never an empty table', async () => {
      expect(await readTcpTable(new Set([1]), 'win32', async () => undefined)).toBeUndefined();
      expect(await readTcpTable(new Set([1]), 'darwin', async () => undefined)).toBeUndefined();
    });
  });

  describe('ancestorsOf', () => {
    it('walks up to the root and stops on a parent created after its child (reused pid)', () => {
      const table = [
        { pid: 1, ppid: 0, created: 10n },
        { pid: 20, ppid: 1, created: 20n },
        { pid: 30, ppid: 20, created: 30n },
        { pid: 40, ppid: 50, created: 40n },
        { pid: 50, ppid: 1, created: 99n },
      ];
      expect(ancestorsOf(table, 30)).toEqual([30, 20, 1]);
      expect(ancestorsOf(table, 40)).toEqual([40]);
      expect(ancestorsOf(table, 777)).toEqual([777]);
    });

    /**
     * D-S01: решению человека важнее самой цепочки то, ДОШЛА ли она до корня.
     * «Предков не видно» (`setsid`, `start /b`, занятый номер родителя) — не
     * повод считать звонящего человеком.
     */
    it('ancestryOf says whether the walk reached the root', () => {
      const table = [
        { pid: 1, ppid: 0, created: 10n },
        { pid: 20, ppid: 1, created: 20n },
        { pid: 30, ppid: 20, created: 30n },
        { pid: 40, ppid: 50, created: 40n },
        { pid: 50, ppid: 1, created: 99n },
        { pid: 60, ppid: 61, created: 10n },
        { pid: 61, ppid: 60, created: 10n },
      ];
      expect(ancestryOf(table, 30)).toEqual({ chain: [30, 20, 1], complete: true });
      // Родитель создан позже ребёнка — номер переиспользован, цепочка оборвана.
      expect(ancestryOf(table, 40)).toEqual({ chain: [40], complete: false });
      // Процесса в таблице нет вовсе: судить нечего.
      expect(ancestryOf(table, 777)).toEqual({ chain: [777], complete: false });
      // Петля родителей не зацикливает обход.
      expect(ancestryOf(table, 60)).toEqual({ chain: [60, 61], complete: false });
      expect(ancestryOf(table, 30, 2)).toEqual({ chain: [30, 20], complete: false });
    });
  });

  describe('real sockets', () => {
    let server: Server | undefined;
    const children: ChildProcess[] = [];

    afterEach(async () => {
      for (const child of children.splice(0)) child.kill();
      await new Promise<void>((done) => (server ? server.close(() => done()) : done()));
      server = undefined;
    });

    it('names the process holding the far end and its parent chain', async () => {
      const accepted = new Promise<Socket>((resolve) => {
        server = createServer((socket) => resolve(socket));
      });
      await new Promise<void>((done) => server!.listen(0, '127.0.0.1', () => done()));
      const port = (server!.address() as { port: number }).port;
      // Родитель → внук: внук держит соединение, родитель — «корень прогона».
      const grandchild = `require('net').connect(${port}, '127.0.0.1'); setInterval(() => {}, 1000);`;
      const parent = spawn(
        process.execPath,
        [
          '-e',
          `const c = require('child_process').spawn(process.execPath, ['-e', ${JSON.stringify(grandchild)}], { stdio: 'inherit' }); process.on('SIGTERM', () => { c.kill(); process.exit(0); }); setInterval(() => {}, 1000);`,
        ],
        { stdio: 'inherit' },
      );
      children.push(parent);
      const socket = await accepted;
      const peerPort = socket.remotePort!;
      const rows = await readTcpTable(new Set([peerPort]));
      expect(rows).toBeDefined();
      const owner = ownerOf(rows!, peerPort, port);
      expect(owner).toBeDefined();
      expect(owner).not.toBe(process.pid);
      expect(owner).not.toBe(parent.pid);
      const table = await readProcessTableAsync();
      const chain = ancestorsOf(table!, owner!);
      expect(chain[0]).toBe(owner);
      expect(chain).toContain(parent.pid);
      expect(chain).toContain(process.pid);
      // Внука снимаем сами: убийство родителя на Windows его не трогает.
      process.kill(owner!);
      socket.destroy();
    }, 30_000);
  });
});
