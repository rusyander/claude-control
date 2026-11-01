import { readFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';
import { hasValue } from './os-kind.ts';
import {
  createLivenessProbe,
  fakeProcessTable,
  identityOfPid,
  livenessIn,
} from './process-identity.ts';
import {
  parseDarwinPs,
  parseProcStat,
  parseWinTable,
  filetimeToMs,
  readLinuxTable,
  type ProcessRow,
} from './process-table.ts';
import { waitFor } from './__fixtures__/harness.ts';

const fixture = (name: string) =>
  readFileSync(new URL(`./__fixtures__/${name}`, import.meta.url), 'utf8');

const row = (pid: number, start: string, ppid = 1): ProcessRow => ({
  pid,
  ppid,
  start,
  startMs: 1000,
});

describe('P12 process identity — fake process table', () => {
  it('P12 same pid + same start → alive; same pid + other start (reused) → dead; absent → dead', async () => {
    const table = fakeProcessTable([row(100, 'A'), row(200, 'B')]);
    const probe = createLivenessProbe(table, 0);
    expect(await probe.isAlive({ pid: 100, start: 'A' })).toBe('alive');
    expect(await probe.isAlive({ pid: 200, start: 'OLD' })).toBe('dead');
    expect(await probe.isAlive({ pid: 300, start: 'C' })).toBe('dead');
  });

  it('P12 OS gave no snapshot → unknown, never dead', async () => {
    const table = fakeProcessTable([row(100, 'A')]);
    table.fail('powershell timed out');
    const probe = createLivenessProbe(table, 0);
    expect(await probe.isAlive({ pid: 100, start: 'A' })).toBe('unknown');
    expect(await probe.identityOf(100)).toEqual({ unknown: 'powershell timed out' });
  });

  it('P12 zombie and start-less rows: zombie → dead, no start exposed → unknown', () => {
    expect(livenessIn([{ ...row(7, 'Z'), zombie: true }], { pid: 7, start: 'Z' })).toBe('dead');
    expect(livenessIn([row(4, '')], { pid: 4, start: 'x' })).toBe('unknown');
  });

  it('P12 one snapshot per tick: 20 questions within the ttl → one OS read', async () => {
    let clock = 0;
    const table = fakeProcessTable([row(1, 'a')]);
    const probe = createLivenessProbe(table, 1_000, () => clock);
    await Promise.all(Array.from({ length: 20 }, () => probe.isAlive({ pid: 1, start: 'a' })));
    expect(table.reads()).toBe(1);
    clock = 1_500;
    await probe.isAlive({ pid: 1, start: 'a' });
    expect(table.reads()).toBe(2);
  });
});

describe('P12 process identity — parsers of recorded OS output', () => {
  it('P12 Windows snapshot: FILETIME start kept exact, startMs from the 1601 epoch', () => {
    const rows = parseWinTable('0 0 0 0\n4 0 0 0\n1234 900 133432704000000000 0\r\n');
    expect(rows.find((r) => r.pid === 1234)).toMatchObject({
      ppid: 900,
      start: '133432704000000000',
    });
    expect(filetimeToMs(133432704000000000n)).toBe(Date.UTC(2023, 10, 1));
    expect(rows.find((r) => r.pid === 4)?.start).toBe('');
  });

  it('P12 Linux /proc/<pid>/stat: comm with spaces and parens does not shift fields', () => {
    const stat =
      '4242 (my (odd) name) S 17 4242 4242 0 -1 4194560 100 0 0 0 1 2 0 0 20 0 1 0 987654 1000 10 ...';
    expect(parseProcStat(stat)).toEqual({
      pid: 4242,
      ppid: 17,
      starttime: '987654',
      state: 'S',
      comm: 'my (odd) name',
      cpuTicks: 3,
    });
  });

  it('P12 macOS ps -o lstart: recorded output → pid, ppid, start token, zombie flag', () => {
    const rows = parseDarwinPs(fixture('darwin-ps-lstart.txt'));
    expect(rows).toHaveLength(5);
    const node = rows.find((r) => r.pid === 51234);
    expect(node?.ppid).toBe(51200);
    expect(node?.start).toMatch(/^\d+:[0-9a-f]{8}$/);
    expect(new Date(node?.startMs ?? 0).getFullYear()).toBe(2026);
    expect(rows.find((r) => r.pid === 51299)?.zombie).toBe(true);
    // Тот же номер, та же секунда, другой argv → другая личность (09: argv hash).
    const again = parseDarwinPs(
      fixture('darwin-ps-lstart.txt').replace('vitest run', 'vitest watch'),
    );
    expect(again.find((r) => r.pid === 51234)?.start).not.toBe(node?.start);
  });
});

describe('P12 process identity — this OS, real processes', () => {
  const spawned: number[] = [];
  afterEach(() => {
    for (const pid of spawned.splice(0)) {
      try {
        process.kill(pid, 'SIGKILL');
      } catch {
        // вышел
      }
    }
  });

  it('P12 a live child: identity read, alive; after kill → dead; same pid with another start → dead', async () => {
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
      stdio: 'ignore',
    });
    const pid = child.pid ?? 0;
    spawned.push(pid);
    const id = await identityOfPid(pid);
    expect(hasValue(id)).toBe(true);
    if (!hasValue(id)) return;
    expect(id.value.pid).toBe(pid);
    const probe = createLivenessProbe(undefined, 0);
    expect(await probe.isAlive(id.value)).toBe('alive');
    expect(await probe.isAlive({ pid, start: `${id.value.start}0` })).toBe('dead');
    const exited = new Promise((done) => child.once('exit', done));
    child.kill('SIGKILL');
    await exited;
    expect(
      await waitFor(
        async () => ((await probe.isAlive(id.value)) === 'dead' ? true : undefined),
        10_000,
        'dead',
      ),
    ).toBe(true);
  });

  it.runIf(process.platform === 'linux')(
    'P12 Linux: /proc table carries boot id + starttime of this process',
    () => {
      const table = readLinuxTable();
      expect(hasValue(table)).toBe(true);
      if (!hasValue(table)) return;
      const self = table.value.find((r) => r.pid === process.pid);
      expect(self?.start).toMatch(/^[0-9a-f-]{1,8}:\d+$/);
      // Родитель из живого /proc — от него строится дерево остановки (P53).
      expect(self?.ppid).toBe(process.ppid);
      expect(Math.abs((self?.startMs ?? 0) - (Date.now() - process.uptime() * 1000))).toBeLessThan(
        5_000,
      );
    },
  );
});
