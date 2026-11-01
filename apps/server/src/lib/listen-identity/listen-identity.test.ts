import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { verifyCoreEntry, type ProcEntry } from '@agentdeck/contracts/core/procs';
import {
  createCoreIdentityDeps,
  darwinStartOf,
  linuxStartOf,
  parseLsofListen,
  parseNetstatListen,
  parseProcNetListen,
  processStartOf,
  procNetAddress,
  readListenTable,
  sameStart,
} from './listen-identity.ts';

/**
 * Чтения ОС, на которых прокладка панели решает, отдать ли bearer ядра (F10). Разборы — на
 * образцах вывода каждой ОС; сверка строки целиком — на настоящем слушателе этого процесса.
 */

describe('listener parsers', () => {
  it('netstat: a listener is a row with remote port 0, whatever the locale calls the state', () => {
    const text = [
      'Active Connections',
      '  Proto  Local Address          Foreign Address        State           PID',
      '  TCP    127.0.0.1:5190         0.0.0.0:0              LISTENING       1234',
      '  TCP    [::1]:5191             [::]:0                 ABHÖREN         77',
      '  TCP    127.0.0.1:5190         127.0.0.1:60000        ESTABLISHED     1234',
      '  UDP    0.0.0.0:5353           *:*                                    9',
    ].join('\r\n');
    expect(parseNetstatListen(text)).toEqual([
      { state: 'listen', localAddress: '127.0.0.1', localPort: 5190, pid: 1234 },
      { state: 'listen', localAddress: '::1', localPort: 5191, pid: 77 },
    ]);
  });

  it('lsof: pid lines own the following endpoints, `*` is any address, connections are skipped', () => {
    const text = ['p42', 'n127.0.0.1:5190', 'n*:5191', 'n127.0.0.1:5190->127.0.0.1:60000'].join(
      '\n',
    );
    expect(parseLsofListen(text)).toEqual([
      { state: 'listen', localAddress: '127.0.0.1', localPort: 5190, pid: 42 },
      { state: 'listen', localAddress: '0.0.0.0', localPort: 5191, pid: 42 },
    ]);
  });

  it('/proc/net: hex addresses decode, only state 0A with an inode is a listener', () => {
    expect(procNetAddress('0100007F')).toBe('127.0.0.1');
    expect(procNetAddress('00000000000000000000000001000000')).toBe('::1');
    expect(procNetAddress('00000000000000000000000000000000')).toBe('::');
    expect(procNetAddress('0000000000000000FFFF00000100007F')).toBe('::ffff:127.0.0.1');
    const text = [
      '  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode',
      '   0: 0100007F:1446 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 31337 1',
      '   1: 0100007F:1446 0100007F:EA60 01 00000000:00000000 00:00000000 00000000  1000        0 31338 1',
      '   2: 0100007F:1447 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 0 1',
    ].join('\n');
    expect(parseProcNetListen(text)).toEqual([
      { localAddress: '127.0.0.1', localPort: 0x1446, inode: '31337' },
    ]);
  });

  it('linux listeners get their owner through /proc/<pid>/fd socket links', async () => {
    if (process.platform === 'win32') return; // ссылки fd на Windows не создаются без прав
    const proc = mkdtempSync(join(tmpdir(), 'cc-proc-'));
    try {
      mkdirSync(join(proc, 'net'));
      writeFileSync(
        join(proc, 'net', 'tcp'),
        'h\n   0: 0100007F:1446 00000000:0000 0A 0:0 0:0 0 1000 0 31337 1\n',
      );
      mkdirSync(join(proc, '555', 'fd'), { recursive: true });
      const { symlinkSync } = await import('node:fs');
      symlinkSync('socket:[31337]', join(proc, '555', 'fd', '3'));
      expect(await readListenTable(0x1446, 'linux', async () => undefined, proc)).toEqual({
        value: [{ state: 'listen', localAddress: '127.0.0.1', localPort: 0x1446, pid: 555 }],
      });
    } finally {
      rmSync(proc, { recursive: true, force: true });
    }
  });
});

describe('process start tokens match the ones the core writes', () => {
  it('linux: `<boot>:<field 22>`, counted after the LAST `)` of the name', () => {
    const fields = Array.from({ length: 20 }, (_, i) => String(i + 3));
    expect(linuxStartOf(`7 (we) ird) ${fields.join(' ')}`, 'abcd1234')).toBe('abcd1234:22');
    expect(linuxStartOf('7 (x) S', 'b')).toBeUndefined();
  });

  it('darwin: whole seconds of lstart plus a hash of ucomm', () => {
    const token = darwinStartOf('Wed Oct 28 10:15:32 2026 node');
    expect(token).toMatch(/^\d+:[0-9a-f]{8}$/);
    expect(darwinStartOf('Wed Oct 28 10:15:32 2026 bash')).not.toBe(token);
    expect(darwinStartOf('garbage')).toBeUndefined();
  });

  it('a win32 start differs by under 1 µs between the helper and the CIM fallback; nothing wider passes', () => {
    expect(sameStart('win32', '134000000000000005', '134000000000000000')).toBe(true);
    expect(sameStart('win32', '134000000000000010', '134000000000000000')).toBe(false);
    expect(sameStart('linux', 'b:10', 'b:11')).toBe(false);
    expect(sameStart('linux', 'b:10', 'b:10')).toBe(true);
  });
});

describe('a real listener of this process verifies, a forged row does not', () => {
  let server: Server | undefined;
  let port = 0;
  let start = '';
  const entry = (row: Partial<ProcEntry>): ProcEntry => ({
    build: 'test',
    pid: process.pid,
    pidStart: start,
    bootId: 'boot',
    port,
    url: `http://127.0.0.1:${port}`,
    startedAt: 1,
    home: 'h',
    portDecision: { rejected: [] },
    ...row,
  });

  beforeAll(async () => {
    server = createServer();
    await new Promise<void>((done) => server!.listen(0, '127.0.0.1', done));
    port = (server.address() as { port: number }).port;
    start = (await processStartOf(process.pid)) ?? '';
  });
  afterAll(() => new Promise<void>((done) => server!.close(() => done())));

  it('the own row is verified; a wrong pid, a wrong start and a dead pid are not', async () => {
    expect(start).not.toBe('');
    const deps = createCoreIdentityDeps();
    expect(await verifyCoreEntry(entry({}), deps(port))).toEqual({ value: true });
    const forged = await Promise.all([
      verifyCoreEntry(entry({ pid: process.ppid }), deps(port)),
      verifyCoreEntry(entry({ pidStart: '1' }), deps(port)),
    ]);
    expect(forged.map((f) => 'unknown' in f)).toEqual([true, true]);
    expect(await processStartOf(2 ** 22 + 7)).toBeNull();
  });

  it('a remembered alive verdict is keyed by pid AND start: another start is read again and refused', async () => {
    // Чтение ОС — `ps` darwin через подставленный exec: считается каждое обращение к ОС.
    let reads = 0;
    let clock = 0;
    const line = 'Wed Oct 28 10:15:32 2026 node';
    const token = darwinStartOf(line)!;
    const deps = createCoreIdentityDeps({
      platform: 'darwin',
      exec: async (cmd) => (cmd === 'ps' ? (reads++, `${line}\n`) : undefined),
      aliveTtlMs: 60_000,
      now: () => clock,
    });
    const probe = deps(port);
    expect(await probe.isAlive({ pid: 9, start: token })).toBe('alive');
    expect(await probe.isAlive({ pid: 9, start: token })).toBe('alive');
    expect(reads).toBe(1);
    expect(await probe.isAlive({ pid: 9, start: '1:deadbeef' })).toBe('dead');
    expect(reads).toBe(2);
    clock = 60_001;
    expect(await probe.isAlive({ pid: 9, start: token })).toBe('alive');
    expect(reads).toBe(3);
  });
});
