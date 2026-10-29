import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { parseDarwinPs, parseProcStat, parseWinTable, readLinuxTable } from './process-table.ts';
import { parseLsofTcp, parseWinTcp, readLinuxTcp, socketOwners } from './tcp-table.ts';

/**
 * Чтение `/proc` ядром (P56, F25) по НАСТОЯЩЕМУ дереву каталогов, собранному в temp: корень
 * `/proc` — параметр, поэтому разбор, пропуски вышедших процессов и отказы по нечитаемой
 * таблице исполняются на любой ОС. Нечитаемое — `unknown`, никогда «процессов нет».
 */

const root = mkdtempSync(join(tmpdir(), 'proc readers ü '));
afterAll(() => rmSync(root, { recursive: true, force: true }));

/** `pid (comm) state ppid …` — 22-е поле starttime. */
function statLine(pid: number, comm: string, state: string, ppid: number, start: number): string {
  const fields = [state, String(ppid), ...Array.from({ length: 17 }, () => '0'), String(start)];
  return `${pid} (${comm}) ${fields.join(' ')} 0 0\n`;
}

function fakeProc(name: string, files: Record<string, string>): string {
  const dir = join(root, name);
  for (const [rel, text] of Object.entries(files)) {
    mkdirSync(join(dir, rel, '..'), { recursive: true });
    writeFileSync(join(dir, rel), text);
  }
  return dir;
}

describe('P56 process table — /proc reader', () => {
  it('P56 /proc rows: start = boot_id:starttime, startMs from btime + ticks/100; Z/X are zombies; a comm with ") (" parsed after the LAST paren; exited and garbage entries skipped', () => {
    const proc = fakeProc('proc-a', {
      stat: 'cpu 1 2 3\nbtime 1700000000\n',
      'sys/kernel/random/boot_id': 'abcdef12-3456-7890\n',
      '1/stat': statLine(1, 'init', 'S', 0, 5),
      '20/stat': statLine(20, 'odd ) (name', 'Z', 1, 250),
      '21/stat': statLine(21, 'dead', 'X', 1, 300),
      '30/stat': 'garbage without parens',
      'self/stat': statLine(99, 'self', 'R', 1, 1),
    });
    mkdirSync(join(proc, '40')); // вышел между readdir и чтением
    const table = readLinuxTable(proc);
    if (!('value' in table)) throw new Error(JSON.stringify(table));
    expect(table.value.sort((a, b) => a.pid - b.pid)).toEqual([
      { pid: 1, ppid: 0, start: 'abcdef12:5', startMs: 1_700_000_000_050, image: 'init' },
      {
        pid: 20,
        ppid: 1,
        start: 'abcdef12:250',
        startMs: 1_700_000_002_500,
        zombie: true,
        image: 'odd ) (name',
      },
      {
        pid: 21,
        ppid: 1,
        start: 'abcdef12:300',
        startMs: 1_700_000_003_000,
        zombie: true,
        image: 'dead',
      },
    ]);
  });

  it('P56 /proc without boot_id → «boot» prefix; /proc/stat without btime or missing → unknown, not an empty table', () => {
    const noBoot = fakeProc('proc-b', {
      stat: 'btime 1700000000\n',
      '7/stat': statLine(7, 'x', 'S', 1, 9),
    });
    expect(readLinuxTable(noBoot)).toEqual({
      value: [{ pid: 7, ppid: 1, start: 'boot:9', startMs: 1_700_000_000_090, image: 'x' }],
    });
    const noBtime = fakeProc('proc-c', { stat: 'cpu 1\n' });
    expect(readLinuxTable(noBtime)).toEqual({ unknown: `${noBtime}/stat has no btime` });
    expect('unknown' in readLinuxTable(join(root, 'no-proc'))).toBe(true);
  });

  it('P56 parsers: a stat line with a non-numeric starttime is refused; Windows rows with created 0 have no start; ps lines with a bad date are skipped', () => {
    expect(parseProcStat('5 (x) S 1 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 zz')).toBeUndefined();
    expect(parseWinTable('4 0 0\nnot a row\n8 4 133000000000000000\n')).toEqual([
      { pid: 4, ppid: 0, start: '', startMs: Number.NaN },
      expect.objectContaining({ pid: 8, ppid: 4, start: '133000000000000000' }),
    ]);
    expect(parseDarwinPs('  10     1 Ss   Xyz Abc 99 99:99:99 2026 /sbin/launchd\n')).toEqual([]);
  });

  it('A2-F02 image column: Windows rows carry the image name (spaces kept, absent when the snapshot has none), macOS rows the ucomm', () => {
    expect(
      parseWinTable('4 0 0 System\n0 0 0\n8 4 133000000000000000 Claude Code Helper.exe\r\n'),
    ).toEqual([
      { pid: 4, ppid: 0, start: '', startMs: Number.NaN, image: 'System' },
      { pid: 0, ppid: 0, start: '', startMs: Number.NaN },
      expect.objectContaining({ pid: 8, image: 'Claude Code Helper.exe' }),
    ]);
    expect(parseDarwinPs('  10     1 Ss   Wed Oct 28 10:15:32 2026 claude\n')).toEqual([
      expect.objectContaining({ pid: 10, ppid: 1, image: 'claude' }),
    ]);
  });
});

describe('P56 TCP table — /proc/net reader and parsers', () => {
  const header =
    '  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode\n';
  const tcpRow = (local: string, remote: string, st: string, inode: string) =>
    `   0: ${local} ${remote} ${st} 00000000:00000000 00:00000000 00000000  1000        0 ${inode} 1 0000000000000000 100 0 0 10 0\n`;

  it('P56 /proc/net/tcp only (no tcp6): rows decoded, no owner without /proc/<pid>/fd; neither table → unknown', () => {
    const proc = fakeProc('net-a', {
      'net/tcp': header + tcpRow('0100007F:1F90', '00000000:0000', '0A', '555') + 'short line\n',
    });
    expect(readLinuxTcp(proc)).toEqual({
      value: [
        {
          state: 'listen',
          localAddress: '127.0.0.1',
          localPort: 8080,
          remoteAddress: '0.0.0.0',
          remotePort: 0,
        },
      ],
    });
    expect(readLinuxTcp(join(root, 'net-none'))).toEqual({
      unknown: expect.stringContaining(`${join(root, 'net-none')}/net/tcp unreadable: `),
    });
  });

  it.runIf(process.platform !== 'win32')(
    'P56 socket inode → owning pid through /proc/<pid>/fd links; unreadable fd dirs and non-socket links skipped',
    () => {
      const proc = fakeProc('net-b', {
        // IPv4-таблица есть всегда; без неё ответ — `unknown` (F-114), не одна половина.
        'net/tcp': header,
        'net/tcp6':
          header +
          tcpRow(
            '00000000000000000000000001000000:0050',
            '00000000000000000000000000000000:0000',
            '01',
            '777',
          ),
      });
      mkdirSync(join(proc, '12', 'fd'), { recursive: true });
      symlinkSync('socket:[777]', join(proc, '12', 'fd', '3'));
      symlinkSync('/dev/null', join(proc, '12', 'fd', '4'));
      // Сокет, о котором не спрашивали (чужой порт процесса): в ответ не попадает.
      symlinkSync('socket:[999]', join(proc, '12', 'fd', '5'));
      mkdirSync(join(proc, '13')); // без fd — процесс вышел
      expect(socketOwners(new Set(['777', '888']), proc)).toEqual(new Map([['777', 12]]));
      expect(readLinuxTcp(proc)).toEqual({
        value: [
          {
            state: 'established',
            localAddress: '::1',
            localPort: 80,
            remoteAddress: '::',
            remotePort: 0,
            pid: 12,
          },
        ],
      });
    },
  );

  it('P56 TCP parsers: Windows state codes other than LISTEN/ESTABLISHED are «other», pid 0 dropped; lsof rows keep pid, remote and TST state', () => {
    expect(parseWinTcp('6 127.0.0.1 5000 1.2.3.4 443 0\nbad\n')).toEqual([
      {
        state: 'other',
        localAddress: '127.0.0.1',
        localPort: 5000,
        remoteAddress: '1.2.3.4',
        remotePort: 443,
      },
    ]);
    const lsof = [
      'p0',
      'n*:7000',
      'TST=LISTEN',
      'p321',
      'n127.0.0.1:7001->127.0.0.1:52000',
      'TST=ESTABLISHED',
      'n[::1]:7002',
      'TST=CLOSE_WAIT',
      'n*:*',
    ].join('\n');
    expect(parseLsofTcp(lsof)).toEqual([
      { state: 'listen', localAddress: '*', localPort: 7000, remoteAddress: '', remotePort: 0 },
      {
        state: 'established',
        localAddress: '127.0.0.1',
        localPort: 7001,
        remoteAddress: '127.0.0.1',
        remotePort: 52000,
        pid: 321,
      },
      {
        state: 'other',
        localAddress: '::1',
        localPort: 7002,
        remoteAddress: '',
        remotePort: 0,
        pid: 321,
      },
    ]);
  });
});
