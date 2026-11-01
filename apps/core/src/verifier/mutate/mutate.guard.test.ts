import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  byBehaviour,
  fakeRunner,
  journals,
  repo,
  row,
  scopeOf,
  SOURCE,
  stateDir,
} from './__fixtures__/plan-repo.ts';
import { platformMutateIo } from './io.ts';
import { sha1 } from './journal.ts';
import type { MutateIo, TestRunner } from './mutate.types.ts';
import { runPlan } from './run.ts';
import { parseVitestReport, vitestRunner } from './vitest-runner.ts';

/**
 * Охрана дерева мутантом (G6): дерево занято с первого мгновения прогона (журнал на диске до базы),
 * свой оставленный журнал возвращается, а не затирается; дети не видят окружения ядра; ни план, ни
 * подложенный журнал не пишут вне дерева; CRLF-файл, изменённый во время базы файл, отчёт мёртвого прогона.
 */

const sum = (dir: string): string => readFileSync(join(dir, 'src', 'sum.mjs'), 'utf8');
const deadPid = (): number => spawnSync(process.execPath, ['-e', '']).pid ?? 1;

/** Ввод-вывод с «живыми» подставными pid: два прогона в одном процессе ведут себя как два процесса. */
function liveIo(live: number[], over: Partial<MutateIo> = {}): MutateIo {
  const real = platformMutateIo();
  return { ...real, pidAlive: (pid) => live.includes(pid) || real.pidAlive(pid), ...over };
}

function plantJournal(dir: string, pid: number, files: Record<string, unknown> = {}): string {
  mkdirSync(stateDir(dir), { recursive: true });
  const file = join(stateDir(dir), `journal-${pid}.json`);
  writeFileSync(
    file,
    JSON.stringify({
      pid,
      scope: scopeOf(dir),
      started: '2026-10-29T00:00:00.000Z',
      cmd: 'x',
      files,
    }),
  );
  return file;
}

describe('verifier/mutate tree guard (G6)', () => {
  it('a run of another process that starts while the first is still in its baseline is refused — the first journal is on disk before its first test run', async () => {
    const dir = repo();
    const first = await import('./run.ts');
    vi.resetModules();
    const second = await import('./run.ts');
    const io = liveIo([111, 222]);
    let release = (): void => undefined;
    const gate = new Promise<void>((done) => (release = done));
    let entered = (): void => undefined;
    const inBaseline = new Promise<void>((done) => (entered = done));
    let calls = 0;
    const gated: TestRunner = {
      run: async () => {
        calls += 1;
        if (calls === 1) {
          entered();
          await gate;
        }
        return byBehaviour(sum(dir));
      },
    };
    const a = first.runPlan([row('a + b', 'a - b')], { root: dir, runner: gated, io, pid: 111 });
    try {
      await inBaseline;
      await expect(
        second.runPlan([row('a + b', 'a - b')], {
          root: dir,
          runner: fakeRunner(dir, byBehaviour),
          io,
          pid: 222,
        }),
      ).rejects.toThrow(/pid 111/);
      expect(sum(dir)).toBe(SOURCE);
    } finally {
      release();
    }
    expect((await a).map((r) => r.outcome)).toEqual(['killed']);
    expect(sum(dir)).toBe(SOURCE);
    expect(journals(dir)).toEqual([]);
  });

  it('two runs that write their journals at the same moment: the one that sees the other after writing backs off and removes its own journal', async () => {
    const dir = repo();
    let planted = false;
    const io = liveIo([111, 222], {
      writeBytes: (path, bytes) => {
        platformMutateIo().writeBytes(path, bytes);
        // Сосед pid 222 записал свой журнал сразу после нашего — до нашей повторной сверки.
        if (!planted && path.endsWith('journal-111.json')) {
          planted = true;
          plantJournal(dir, 222);
        }
      },
    });
    const seen: string[] = [];
    await expect(
      runPlan([row('a + b', 'a - b')], {
        root: dir,
        runner: fakeRunner(dir, byBehaviour, seen),
        io,
        pid: 111,
      }),
    ).rejects.toThrow(/pid 222/);
    expect(seen).toEqual([]);
    expect(journals(dir)).toEqual(['journal-222.json']);
    expect(sum(dir)).toBe(SOURCE);
  });

  it('a journal this process left (restore did not verify) is restored by the next run of the same process, never overwritten', async () => {
    const dir = repo();
    const real = platformMutateIo();
    let writes = 0;
    const stuckIo: MutateIo = {
      ...real,
      writeBytes: (path, bytes) => {
        if (path.endsWith('sum.mjs')) {
          writes += 1;
          if (writes > 1) return; // возврат «молча не лёг»
        }
        real.writeBytes(path, bytes);
      },
    };
    await expect(
      runPlan([row('a + b', 'a - b')], {
        root: dir,
        runner: fakeRunner(dir, byBehaviour),
        io: stuckIo,
      }),
    ).rejects.toThrow(/НЕ ВЕРНУЛИСЬ/);
    expect(journals(dir)).toEqual([`journal-${process.pid}.json`]);
    const lines: string[] = [];
    const results = await runPlan([row('a + b', 'a - b')], {
      root: dir,
      runner: fakeRunner(dir, byBehaviour),
      progress: (l) => lines.push(l),
    });
    expect(lines.some((l) => /вернул 1 файл/.test(l))).toBe(true);
    expect(results.map((r) => r.outcome)).toEqual(['killed']);
    expect(sum(dir)).toBe(SOURCE);
    expect(journals(dir)).toEqual([]);
  });

  it('two runPlan calls started in the same tick: the second is refused, the tree ends byte-equal', async () => {
    const dir = repo();
    const a = runPlan([row('a + b', 'a - b')], { root: dir, runner: fakeRunner(dir, byBehaviour) });
    const b = runPlan([row('a + b', 'a - b')], { root: dir, runner: fakeRunner(dir, byBehaviour) });
    await expect(b).rejects.toThrow(/уже идёт/);
    expect((await a).map((r) => r.outcome)).toEqual(['killed']);
    expect(sum(dir)).toBe(SOURCE);
    expect(journals(dir)).toEqual([]);
  });

  it('runner children get the allow-listed base env (or the injected one), never the core process env; MUSTFAIL_PID and a per-run temp are set', async () => {
    const dir = repo();
    const envs: NodeJS.ProcessEnv[] = [];
    const runner: TestRunner = {
      run: async (_row, ctx) => {
        envs.push(ctx.env);
        return byBehaviour(sum(dir));
      },
    };
    process.env.AGENTDECK_MUTATE_PROBE_SECRET = 'leak';
    try {
      await runPlan([row('a + b', 'a - b')], { root: dir, runner });
      await runPlan([row('a + b', 'a - b')], { root: dir, runner, env: { ONLY: 'this' } });
    } finally {
      delete process.env.AGENTDECK_MUTATE_PROBE_SECRET;
    }
    const [base, injected] = [envs[0] ?? {}, envs.at(-1) ?? {}];
    expect(base.AGENTDECK_MUTATE_PROBE_SECRET).toBeUndefined();
    expect(base.PATH).toBeTruthy();
    expect(base.MUSTFAIL_PID).toBe(String(process.pid));
    // Своя папка прогона — во временном каталоге системы, не под `.git` (тест с `git init` в TEMP).
    expect(base.TMPDIR?.startsWith(join(tmpdir(), 'agentdeck-mutate-'))).toBe(true);
    expect(base.TMPDIR?.startsWith(stateDir(dir))).toBe(false);
    expect(injected.ONLY).toBe('this');
    expect(injected.AGENTDECK_MUTATE_PROBE_SECRET).toBeUndefined();
    expect(injected.MUSTFAIL_PID).toBe(String(process.pid));
  });

  it('a plan row naming a file outside the git tree is not applied — nothing outside is written', async () => {
    const dir = repo();
    const outside = join(mkdtempSync(join(tmpdir(), 'mut-out-')), 'secret.txt');
    writeFileSync(outside, 'secret = 1\n');
    const seen: string[] = [];
    const runner: TestRunner = {
      run: async () => {
        seen.push(readFileSync(outside, 'utf8'));
        return byBehaviour(sum(dir));
      },
    };
    const results = await runPlan([{ ...row('secret = 1', 'secret = 2'), file: outside }], {
      root: dir,
      runner,
    });
    expect(results[0]).toMatchObject({
      outcome: 'not-applied',
      detail: expect.stringMatching(/вне/),
    });
    expect(seen.every((s) => s === 'secret = 1\n')).toBe(true);
    expect(readFileSync(outside, 'utf8')).toBe('secret = 1\n');
  });

  it('a planted journal naming a file outside the tree, a backup outside its run dir or a foreign shape is refused — restore never writes there', async () => {
    const victimDir = mkdtempSync(join(tmpdir(), 'mut-victim-'));
    const victim = join(victimDir, 'settings.json');
    writeFileSync(victim, '{"real":true}\n');
    const evil = join(victimDir, 'evil');
    writeFileSync(evil, 'ATTACKER CONTENT\n');
    const evilSha = sha1(Buffer.from('ATTACKER CONTENT\n'));
    const opts = (dir: string) => ({ root: dir, runner: fakeRunner(dir, byBehaviour) });

    const outsideFile = repo();
    plantJournal(outsideFile, deadPid(), {
      [victim]: { backup: evil, before: evilSha, written: [sha1(Buffer.from('{"real":true}\n'))] },
    });
    await expect(runPlan([row('a + b', 'a - b')], opts(outsideFile))).rejects.toThrow(/вне/);
    expect(readFileSync(victim, 'utf8')).toBe('{"real":true}\n');

    const outsideBackup = repo();
    const target = join(outsideBackup, 'src', 'sum.mjs');
    plantJournal(outsideBackup, deadPid(), {
      [target]: { backup: evil, before: evilSha, written: [sha1(Buffer.from(SOURCE))] },
    });
    await expect(runPlan([row('a + b', 'a - b')], opts(outsideBackup))).rejects.toThrow(/вне/);
    expect(sum(outsideBackup)).toBe(SOURCE);

    const foreign = repo();
    mkdirSync(stateDir(foreign), { recursive: true });
    writeFileSync(join(stateDir(foreign), 'journal-77.json'), JSON.stringify({ pid: '77/..' }));
    await expect(runPlan([row('a + b', 'a - b')], opts(foreign))).rejects.toThrow(/не разбирается/);
  });

  it('a multi-line find written with \\n applies to a CRLF file; the file comes back byte-equal', async () => {
    const crlf = 'export const add = (a, b) =>\r\n  a + b;\r\n';
    const dir = repo(crlf);
    const seen: string[] = [];
    const results = await runPlan(
      [row('export const add = (a, b) =>\n  a + b;', 'export const add = (a, b) =>\n  a - b;')],
      { root: dir, runner: fakeRunner(dir, byBehaviour, seen) },
    );
    expect(results.map((r) => r.outcome)).toEqual(['killed']);
    expect(seen[1]).toBe('export const add = (a, b) =>\r\n  a - b;\r\n');
    expect(sum(dir)).toBe(crlf);
  });

  it('a file changed by someone else while the baseline ran is not mutated and keeps that edit', async () => {
    const dir = repo();
    const edited = 'export const add = (a, b) => a + b; // edited\n';
    let calls = 0;
    const runner: TestRunner = {
      run: async () => {
        calls += 1;
        if (calls === 1) writeFileSync(join(dir, 'src', 'sum.mjs'), edited);
        return byBehaviour(sum(dir));
      },
    };
    const results = await runPlan([row('a + b', 'a - b')], { root: dir, runner });
    expect(results[0]).toMatchObject({
      outcome: 'not-applied',
      detail: expect.stringMatching(/изменился/),
    });
    expect(calls).toBe(1);
    expect(sum(dir)).toBe(edited);
  });
});

describe('verifier/mutate vitest runner report', () => {
  it('a vitest that writes no report is not-run — a report left by a dead run with the same name is never read', async () => {
    const scratch = mkdtempSync(join(tmpdir(), 'mut-scratch-'));
    const stale = JSON.stringify({
      testResults: [
        {
          status: 'passed',
          assertionResults: [{ title: 'adds', ancestorTitles: ['sum'], status: 'passed' }],
        },
      ],
    });
    for (let n = 1; n <= 20; n += 1) writeFileSync(join(scratch, `report-${n}.json`), stale);
    const noop = join(scratch, 'noop.mjs');
    writeFileSync(noop, '');
    const out = await vitestRunner({ entry: noop }).run(
      { spec: 'sum.test.mjs', test: 'sum > adds' },
      { root: scratch, scratchDir: scratch, env: { PATH: process.env.PATH ?? '' } },
    );
    expect(out).toMatchObject({
      kind: 'not-run',
      reason: expect.stringMatching(/не записал отчёт/),
    });
  });

  it('the named test matches by its full path or a describe path covering it — never a sibling with the same leaf name', () => {
    const report = JSON.stringify({
      testResults: [
        {
          status: 'failed',
          assertionResults: [
            { ancestorTitles: ['other', 'sum'], title: 'adds', status: 'failed' },
            { ancestorTitles: ['sum'], title: 'adds', status: 'passed' },
          ],
        },
      ],
    });
    const exact = parseVitestReport(report, 'sum > adds', 1);
    expect(exact.kind === 'ran' && exact.tests).toEqual([{ path: 'sum > adds', status: 'passed' }]);
    const describe = parseVitestReport(report, 'sum', 1);
    expect(describe.kind === 'ran' && describe.tests).toEqual([
      { path: 'sum > adds', status: 'passed' },
    ]);
  });
});
