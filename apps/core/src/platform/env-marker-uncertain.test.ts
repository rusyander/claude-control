import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { judgeWinEnviron, parseWinEnviron, sweepMarker } from './env-marker.ts';
import { fakeProcessTable } from './process-identity.ts';

const dirs: string[] = [];
afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

describe('F-55 env-marker sweep — uncertainty is unknown, never «none marked»', () => {
  it('F-55 Windows: a hit whose creation time the OS did not give → unknown, not an empty answer', () => {
    const scan = parseWinEnviron('reader 8192\nhit 123 0\ndone 5 0 0 0\n');
    expect(scan).toBeDefined();
    expect(judgeWinEnviron(scan!)).toMatchObject({ unknown: expect.stringContaining('123') });
  });

  it('F-55 Windows: a hit with a creation time next to a hit without one → the proven hit wins', () => {
    const scan = parseWinEnviron('reader 8192\nhit 123 0\nhit 124 555\ndone 5 0 0 0\n');
    expect(judgeWinEnviron(scan!)).toEqual({ value: [{ pid: 124, start: '555' }] });
  });

  it('F-55 Linux: an own-user process whose environ is unreadable (EACCES) → unknown', async () => {
    const proc = mkdtempSync(join(tmpdir(), 'fake-proc-'));
    dirs.push(proc);
    mkdirSync(join(proc, '42'));
    writeFileSync(join(proc, '42', 'environ'), 'A=1\0');
    mkdirSync(join(proc, '43'));
    const denied = Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' });
    const found = await sweepMarker(
      'AGENTDECK_TREE',
      'x',
      fakeProcessTable([]),
      'linux',
      proc,
      undefined,
      {
        readEnviron: (pid) => {
          if (pid === '43') throw denied;
          return 'A=1\0';
        },
        ownerOf: () => 'self',
      },
    );
    expect(found).toMatchObject({ unknown: expect.stringContaining('43') });
  });

  it("F-55 Linux: EACCES on another user's process is not a suspect; ENOENT (exited) neither", async () => {
    const proc = mkdtempSync(join(tmpdir(), 'fake-proc-'));
    dirs.push(proc);
    mkdirSync(join(proc, '50'));
    mkdirSync(join(proc, '51'));
    const fail = (code: string) => Object.assign(new Error(code), { code });
    const found = await sweepMarker(
      'AGENTDECK_TREE',
      'x',
      fakeProcessTable([]),
      'linux',
      proc,
      undefined,
      {
        readEnviron: (pid) => {
          throw pid === '50' ? fail('EACCES') : fail('ENOENT');
        },
        ownerOf: () => 'other',
      },
    );
    expect(found).toEqual({ value: [] });
  });

  it('F-55 Linux: an own process unreadable on the first look and gone on the second (it was exiting) is not a suspect', async () => {
    const proc = mkdtempSync(join(tmpdir(), 'fake-proc-'));
    dirs.push(proc);
    mkdirSync(join(proc, '44'));
    const fail = (code: string) => Object.assign(new Error(code), { code });
    let looks = 0;
    const found = await sweepMarker(
      'AGENTDECK_TREE',
      'x',
      fakeProcessTable([]),
      'linux',
      proc,
      undefined,
      {
        readEnviron: () => {
          looks += 1;
          throw fail(looks === 1 ? 'EACCES' : 'ENOENT');
        },
        ownerOf: () => 'self',
      },
    );
    expect(found).toEqual({ value: [] });
    expect(looks).toBe(2);
  });

  it('F-55 Linux: with the root start given, an own unreadable process born before the root is not a suspect; one born after still is', async () => {
    const proc = mkdtempSync(join(tmpdir(), 'fake-proc-'));
    dirs.push(proc);
    mkdirSync(join(proc, '60'));
    mkdirSync(join(proc, '61'));
    const denied = Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' });
    const io = {
      readEnviron: (): string => {
        throw denied;
      },
      ownerOf: () => 'self' as const,
    };
    // 60 — демон старше корня (ssh-agent), 61 — родился после корня: мог унаследовать метку.
    const table = fakeProcessTable([
      { pid: 60, ppid: 1, start: 's60', startMs: 1_000 },
      { pid: 61, ppid: 1, start: 's61', startMs: 10_000 },
    ]);
    const sweep = () =>
      sweepMarker('AGENTDECK_TREE', 'x', table, 'linux', proc, undefined, io, {
        bornAfterMs: 5_000,
      });
    const both = await sweep();
    expect(both).toMatchObject({ unknown: expect.stringContaining('(pid 61)') });
    rmSync(join(proc, '61'), { recursive: true });
    expect(await sweep()).toEqual({ value: [] });
    // Без времени корня старший закрытый — по-прежнему сомнение: судить его не по чему.
    expect(
      await sweepMarker('AGENTDECK_TREE', 'x', table, 'linux', proc, undefined, io),
    ).toMatchObject({ unknown: expect.stringContaining('(pid 60)') });
  });

  it.runIf(process.platform === 'linux')(
    'F-64 Linux: an own zombie (environ EACCES, nothing running) is not a suspect — the real /proc sweep stays clean',
    async () => {
      // `sh` заменяется `sleep 3`, который не собирает своего ребёнка `true` — тот висит зомби.
      const parent = spawn('sh', ['-c', 'true & exec sleep 3'], { stdio: 'ignore' });
      try {
        let zombie: string | undefined;
        for (let i = 0; i < 100 && !zombie; i += 1) {
          await new Promise((resolve) => setTimeout(resolve, 20));
          zombie = readdirSync('/proc').find((entry) => {
            if (!/^\d+$/.test(entry)) return false;
            try {
              const status = readFileSync(`/proc/${entry}/status`, 'utf8');
              return (
                new RegExp(`^PPid:\\s+${parent.pid}$`, 'm').test(status) &&
                /^State:\s+Z/m.test(status)
              );
            } catch {
              return false;
            }
          });
        }
        expect(zombie).toBeDefined();
        const found = await sweepMarker(
          'AGENTDECK_TREE',
          `f64-none-${process.pid}`,
          fakeProcessTable([]),
          'linux',
        );
        expect(found).toEqual({ value: [] });
      } finally {
        parent.kill('SIGKILL');
      }
    },
  );

  it.runIf(process.platform === 'win32')(
    'F-55 Windows: the marker name matches case-insensitively (Windows env names ignore case)',
    async () => {
      const value = `f55-${process.pid}-${Date.now()}`;
      const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)'], {
        env: { ...process.env, agentdeck_tree_f55: value },
        stdio: 'ignore',
      });
      try {
        await new Promise((resolve) => setTimeout(resolve, 300));
        const found = await sweepMarker('AGENTDECK_TREE_F55', value);
        expect(found).toMatchObject({ value: [expect.objectContaining({ pid: child.pid })] });
      } finally {
        child.kill();
      }
    },
    60_000,
  );
});
