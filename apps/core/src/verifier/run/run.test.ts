import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { CheckEntry } from '@agentdeck/contracts/core/records';
import { afterAll, describe, expect, it } from 'vitest';
import { argvFor, expandTemplate, selectionArgs } from './argv.ts';
import { DEFAULT_DEADLINE_MS, MIN_DEADLINE_MS, deadlineOf, p95 } from './deadline.ts';
import { FILTER_KINDS, parseFailing, parsePassing, passingOf, testsRan } from './failing.ts';
import { CHECK_LEASE_ENV, CappedLog, runCheck } from './run.ts';
import type { RunDeps, RunLease, RunSpec } from './run.types.ts';
import { narrowVerdict, verdictOf } from './verdict.ts';

/**
 * Прогон проверки (04:15, D§3.8, P40): настоящий дочерний node, настоящее дерево, настоящий
 * временный каталог. Подставлены только эпоха стенда и удар аренды — внешняя граница.
 */

const CHILD = fileURLToPath(new URL('./__fixtures__/child.mjs', import.meta.url));
const roots: string[] = [];
const root = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'adk-run-'));
  roots.push(dir);
  return dir;
};
afterAll(() => {
  for (const dir of roots) rmSync(dir, { recursive: true, force: true });
});

const ENTRY: CheckEntry = {
  id: 'unit-tests',
  class: 'test-runner',
  argv: ['vitest', 'run', '{units}'],
  cwd: '',
  unit: 'package',
  requiredAt: ['publish'],
  baseDependent: false,
  filter: { kind: 'vitest', argv: ['vitest', 'run', '{units}', '-t', '{tests}'] },
  inputs: [],
  envAllow: [],
  tools: [],
  artifacts: [],
  needs: [],
  source: 'detected',
};

function pinned(): Record<string, string> {
  const env: Record<string, string> = { PINNED_BY_PROFILE: 'yes' };
  for (const name of ['PATH', 'Path', 'SystemRoot', 'SYSTEMROOT', 'windir']) {
    const value = process.env[name];
    if (value !== undefined) env[name] = value;
  }
  return env;
}

function spec(args: string[], over: Partial<RunSpec> = {}): RunSpec {
  const dir = root();
  return {
    checkRunId: `run-${Math.random().toString(16).slice(2)}`,
    taskId: 'task-1',
    entry: ENTRY,
    argv: [process.execPath, CHILD, ...args],
    cwd: dir,
    env: pinned(),
    tempRoot: join(dir, 'tmp'),
    deadlineMs: 60_000,
    ...over,
  };
}

function lease(answer: () => ReturnType<RunLease['heartbeat']> = () => 'ok'): RunLease {
  return { leaseId: 'lease-abc', beatMs: 50, heartbeat: answer };
}

const deps = (over: Partial<RunDeps> = {}): RunDeps => ({
  now: Date.now,
  standEpoch: () => 7,
  graceMs: 300,
  ...over,
});

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function goneWithin(pid: number, ms: number): Promise<boolean> {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (!alive(pid)) return true;
    await new Promise((r) => setTimeout(r, 100));
  }
  return !alive(pid);
}

describe('check runner (04:15, D§3.8, P40)', () => {
  it('P40 pinned env only, lease marker set, own temp dir removed after, exit 0 is pass', async () => {
    process.env.AGENTDECK_RUN_TEST_LEAK = 'core-secret';
    try {
      const s = spec(['env', '0']);
      const result = await runCheck(s, lease(), deps());
      const seen = JSON.parse(result.log.trim()) as Record<string, string | null>;
      expect(seen.lease).toBe('lease-abc');
      expect(seen.pinned).toBe('yes');
      // Окружение ядра в прогон не течёт: пин профиля — целиком и только он.
      expect(seen.leak).toBeNull();
      expect(resolve(seen.tmp!)).toBe(resolve(join(s.tempRoot, s.checkRunId)));
      expect(result.temp).toEqual({ removed: true });
      expect(existsSync(join(s.tempRoot, s.checkRunId))).toBe(false);
      expect(result.end).toBe('exit');
      expect(result.exit).toBe(0);
      expect(verdictOf(result)).toEqual({ kind: 'pass' });
      expect(CHECK_LEASE_ENV).toBe('AGENTDECK_CHECK_LEASE');
    } finally {
      delete process.env.AGENTDECK_RUN_TEST_LEAK;
    }
  });

  it('red exit parses failing tests, collect errors are not tests, verdict fail(red)', async () => {
    const result = await runCheck(spec(['vitest-red']), lease(), deps());
    expect(result.exit).toBe(1);
    expect(result.failing).toEqual([{ file: 'src/a.test.ts', name: 'outer > breaks on x' }]);
    expect(verdictOf(result)).toEqual({ kind: 'fail', reason: 'red' });
  });

  it('P40 deadline (p95 x3) stops the whole tree, grandchild included; aborted is not red', async () => {
    const result = await runCheck(spec(['tree'], { deadlineMs: 1_500 }), lease(), deps());
    expect(result.end).toBe('deadline');
    const grand = Number(/grandchild (\d+)/.exec(result.log)?.[1]);
    expect(grand).toBeGreaterThan(0);
    expect(await goneWithin(grand, 5_000)).toBe(true);
    expect(result.temp).toEqual({ removed: true });
    expect(verdictOf(result)).toEqual({ kind: 'no-verdict', reason: 'aborted' });
  }, 30_000);

  it('external abort (pause, cancel) stops the run with no-verdict(aborted)', async () => {
    const ctl = new AbortController();
    setTimeout(() => ctl.abort(), 800);
    const result = await runCheck(spec(['tree']), lease(), deps({ signal: ctl.signal }));
    expect(result.end).toBe('aborted');
    expect(verdictOf(result)).toEqual({ kind: 'no-verdict', reason: 'aborted' });
  }, 30_000);

  it('lost lease stops the run; an unreadable beat does not', async () => {
    let beats = 0;
    const result = await runCheck(
      spec(['tree']),
      lease(() => {
        beats += 1;
        return beats < 5 ? { unknown: 'lease file busy' } : 'lost';
      }),
      deps(),
    );
    expect(beats).toBeGreaterThanOrEqual(5);
    expect(result.end).toBe('lease-lost');
    expect(verdictOf(result)).toEqual({ kind: 'no-verdict', reason: 'aborted' });
  }, 30_000);

  it('stand epoch moved during the run is no-verdict(stand), never red', async () => {
    let epoch = 1;
    const result = await runCheck(spec(['env', '1']), lease(), deps({ standEpoch: () => epoch++ }));
    expect(result.standMoved).toBe(true);
    expect(result.standEpoch).toBe(2);
    expect(verdictOf(result)).toEqual({ kind: 'no-verdict', reason: 'stand' });
  });

  it('unresolvable runner is spawn-failed and no-verdict(env)', async () => {
    const result = await runCheck(
      spec([], { argv: ['agentdeck-no-such-runner-xyz'] }),
      lease(),
      deps(),
    );
    expect(result.end).toBe('spawn-failed');
    expect(result.reason).toMatch(/not found/);
    expect(verdictOf(result)).toEqual({ kind: 'no-verdict', reason: 'env' });
  });

  it('output over the cap keeps head and tail and names the cut', async () => {
    const result = await runCheck(spec(['big', String(3 * 1024 * 1024)]), lease(), deps());
    expect(result.truncated).toBe(true);
    expect(result.logBytes).toBeGreaterThan(3 * 1024 * 1024 - 100);
    expect(result.log.startsWith('HEAD-MARK')).toBe(true);
    expect(result.log.trimEnd().endsWith('TAIL-MARK')).toBe(true);
    expect(result.log).toMatch(/\[… \d+ bytes cut …\]/);
  }, 30_000);
});

describe('check runner pure parts', () => {
  it('capped log keeps everything under the cap', () => {
    const log = new CappedLog(10);
    log.push(Buffer.from('abc'));
    log.push(Buffer.from('de'));
    expect(log.text()).toBe('abcde');
    log.push(Buffer.from('fghijklmno'));
    expect(log.truncated).toBe(true);
    expect(log.text()).toBe('abcde\n[… 5 bytes cut …]\nklmno');
  });

  it('failing-test parsers: one table row per runner kind, collect errors excluded', () => {
    const table: Record<
      (typeof FILTER_KINDS)[number],
      [string, { file?: string; name: string }[]]
    > = {
      vitest: [
        ' FAIL  |core| src/x.test.ts > a > b\n FAIL  src/y.test.ts\n',
        [{ file: 'src/x.test.ts', name: 'a > b' }],
      ],
      jest: [
        'FAIL src/x.test.js\n  ● suite › case one\n  ● Test suite failed to run\n',
        [{ file: 'src/x.test.js', name: 'suite > case one' }],
      ],
      pytest: [
        'FAILED tests/t.py::TestA::test_b - assert 1\nERROR tests/u.py\n',
        [{ file: 'tests/t.py', name: 'TestA::test_b' }],
      ],
      go: ['--- FAIL: TestThing (0.01s)\n', [{ name: 'TestThing' }]],
      cargo: ['test mod::it_works ... FAILED\n', [{ name: 'mod::it_works' }]],
      dotnet: ['  Failed Ns.Cls.Method [12 ms]\n', [{ name: 'Ns.Cls.Method' }]],
      playwright: [
        '  1) [chromium] › a.spec.ts:3:5 › suite › opens ───\n',
        [{ file: 'a.spec.ts', name: 'suite > opens' }],
      ],
      gradle: ['ClsTest > method() FAILED\n', [{ name: 'ClsTest > method()' }]],
      maven: [
        '[ERROR] a.b.ClsTest.method -- Time elapsed: 0.1 s <<< FAILURE!\n[ERROR] Tests run: 3, Failures: 1, Errors: 0, Skipped: 0, Time elapsed: 1 s <<< FAILURE!\n',
        [{ name: 'a.b.ClsTest.method' }],
      ],
    };
    expect(Object.keys(table).sort()).toEqual([...FILTER_KINDS].sort());
    for (const kind of FILTER_KINDS) {
      const [log, want] = table[kind];
      expect({ kind, got: parseFailing(kind, `\u001b[31m${log}\u001b[0m`) }).toEqual({
        kind,
        got: want,
      });
    }
    expect(parseFailing(undefined, ' FAIL  src/x.test.ts > a')).toEqual([]);
  });

  it('passing-test parsers: only runners whose output names passes; skipped, failed and file lines are not passes', () => {
    const table: Partial<
      Record<(typeof FILTER_KINDS)[number], [string, { file?: string; name: string }[]]>
    > = {
      // строки — вывод vitest 4.1 `--reporter=verbose` на этом репозитории
      vitest: [
        ' ✓ src/verifier/run/run.test.ts > check runner (04:15, D§3.8, P40) > exit 0 is pass 613ms\n' +
          ' √ |core| src/a.test.ts > a > b 1ms\n × src/a.test.ts > a > c 2ms\n ↓ src/a.test.ts > a > d\n' +
          ' ✓ src/a.test.ts (3 tests) 5ms\n',
        [
          {
            file: 'src/verifier/run/run.test.ts',
            name: 'check runner (04:15, D§3.8, P40) > exit 0 is pass',
          },
          { file: 'src/a.test.ts', name: 'a > b' },
        ],
      ],
      pytest: [
        'tests/t.py::TestA::test_b PASSED   [ 50%]\ntests/t.py::TestA::test_c FAILED   [100%]\n',
        [{ file: 'tests/t.py', name: 'TestA::test_b' }],
      ],
      go: ['--- PASS: TestThing (0.01s)\n--- FAIL: TestOther (0.01s)\n', [{ name: 'TestThing' }]],
      cargo: [
        'test mod::it_works ... ok\ntest mod::other ... FAILED\n',
        [{ name: 'mod::it_works' }],
      ],
      dotnet: [
        '  Passed Ns.Cls.Method [12 ms]\n  Failed Ns.Cls.Other [1 ms]\n',
        [{ name: 'Ns.Cls.Method' }],
      ],
      playwright: [
        '  ✓  1 [chromium] › a.spec.ts:3:5 › suite › opens (1.2s)\n  ✘  2 [chromium] › a.spec.ts:9:5 › suite › shuts (1.0s)\n',
        [{ file: 'a.spec.ts', name: 'suite > opens' }],
      ],
      gradle: [
        'ClsTest > method() PASSED\nClsTest > other() FAILED\n',
        [{ name: 'ClsTest > method()' }],
      ],
    };
    for (const [kind, [log, want]] of Object.entries(table) as [
      (typeof FILTER_KINDS)[number],
      [string, { file?: string; name: string }[]],
    ][])
      expect({ kind, got: parsePassing(kind, `\u001b[32m${log}\u001b[0m`) }).toEqual({
        kind,
        got: want,
      });
    // обычный репортёр vitest, jest и maven прошедших не называют — запись про отдельный тест молчит
    expect(
      parsePassing('vitest', ' Test Files  1 passed (1)\n      Tests  14 passed (14)\n'),
    ).toBeUndefined();
    expect(parsePassing('jest', '  ✓ case one (5 ms)\n')).toBeUndefined();
    expect(parsePassing('maven', '[INFO] Tests run: 3, Failures: 0\n')).toBeUndefined();
    expect(passingOf('timeout', 'vitest', ' ✓ src/a.test.ts > a > b 1ms\n')).toEqual({});
  });

  it('argv template: whole placeholder spreads, inline joins, narrow only with a filter', () => {
    expect(
      expandTemplate(['run', '{files}', '--base={base}', '{units}'], {
        unit: 'apps/core',
        selection: [],
        base: null,
        files: ['a.ts', 'b.ts'],
      }),
    ).toEqual(['run', 'a.ts', 'b.ts', '--base=', 'apps/core']);
    // `{units}` внутри элемента повторяет элемент на единицу; вся копия (`.`) — без аргумента.
    const one = { selection: [], base: null, files: [] };
    expect(expandTemplate(['--filter={units}', 'x'], { ...one, unit: 'web' })).toEqual([
      '--filter=web',
      'x',
    ]);
    expect(expandTemplate(['--filter={units}', '{units}', 'x'], { ...one, unit: '.' })).toEqual([
      'x',
    ]);
    const input = { unit: 'u', selection: ['t1', 't2'], base: 'abc', files: [] };
    expect(argvFor(ENTRY, input)).toEqual({
      argv: ['vitest', 'run', 'u', '-t', 't1|t2'],
      narrowed: true,
    });
    const { filter: _drop, ...plain } = ENTRY;
    expect(argvFor(plain, input)).toEqual({ argv: ['vitest', 'run', 'u'], narrowed: false });
    // Раннер не берёт несколько имён одной командой — вся единица, `narrowed: false`.
    const cargo: CheckEntry = {
      ...ENTRY,
      filter: { kind: 'cargo', argv: ['cargo', 'test', '{tests}'] },
    };
    expect(argvFor(cargo, input)).toEqual({ argv: ['vitest', 'run', 'u'], narrowed: false });
  });

  it('{tests} selection: a full name becomes each runner own filter form, never verbatim', () => {
    const table: Record<(typeof FILTER_KINDS)[number], [string[], string[] | null]> = {
      vitest: [['outer > in.ner > it (x)', 'b'], ['outer(?: > | )in\\.ner(?: > | )it \\(x\\)|b']],
      jest: [['suite > case one'], ['suite(?: > | )case one']],
      playwright: [['suite > opens'], ['suite(?: > | )opens']],
      go: [['TestA/sub', 'TestA/other', 'TestB'], ['^(?:TestA|TestB)$']],
      pytest: [
        ['TestA::test_b[1]', 'test_c'],
        ['-k', '(TestA and test_b) or (test_c)'],
      ],
      dotnet: [['Ns.Cls.M(1)'], ['FullyQualifiedName~Ns.Cls.M\\(1\\)']],
      maven: [['a.b.Cls.m', 'm2(a.b.Cls)'], ['a.b.Cls#m,a.b.Cls#m2']],
      gradle: [['ClsTest > method()'], ['ClsTest.method']],
      cargo: [['mod::it_works'], ['mod::it_works']],
    };
    expect(Object.keys(table).sort()).toEqual([...FILTER_KINDS].sort());
    for (const kind of FILTER_KINDS) {
      const [names, want] = table[kind];
      expect({ kind, got: selectionArgs(kind, names) }).toEqual({ kind, got: want });
    }
    expect(selectionArgs('gradle', ['a', 'b'])).toBeNull();
    expect(selectionArgs('cargo', ['a', 'b'])).toBeNull();
    expect(selectionArgs('vitest', [])).toEqual([]);
  });

  it('tests run: a narrow pass counts only with ≥1 executed test; 0 or no summary is no-verdict', () => {
    const table: [(typeof FILTER_KINDS)[number], string, number | null][] = [
      ['vitest', '\u001b[2m      Tests \u001b[22m 1 passed | 3 skipped (4)\n', 1],
      ['vitest', ' Test Files  1 skipped (1)\n      Tests  2 skipped (2)\n', 0],
      ['vitest', 'No test files found, exiting with code 0\n', 0],
      ['vitest', 'garbage\n', null],
      ['jest', 'Tests:       1 failed, 2 passed, 3 total\n', 3],
      ['jest', 'No tests found, exiting with code 0\n', 0],
      ['playwright', '  2 passed (3s)\n  1 flaky\n', 3],
      ['pytest', '===== 1 passed, 4 deselected in 0.10s =====\n', 1],
      ['pytest', '===== 5 deselected in 0.10s =====\n', 0],
      ['go', 'ok  \tpkg/a\t0.1s\n', 1],
      ['go', 'ok  \tpkg/a\t0.1s [no tests to run]\n', 0],
      ['cargo', 'test result: ok. 0 passed; 0 failed; 0 ignored\n', 0],
      ['cargo', 'test result: ok. 2 passed; 0 failed; 0 ignored\n', 2],
      ['dotnet', 'No test matches the given testcase filter `X`\n', 0],
      ['dotnet', 'Passed!  - Failed:     0, Passed:     2, Skipped:     0\n', 2],
      ['gradle', '', Infinity],
      ['maven', '[INFO] No tests to run.\n', 0],
      ['maven', '', null],
    ];
    for (const [kind, log, want] of table)
      expect({ kind, log, got: testsRan(kind, log) }).toEqual({ kind, log, got: want });
    const pass = { kind: 'pass' } as const;
    expect(narrowVerdict(pass, null)).toEqual({ verdict: pass });
    expect(narrowVerdict(pass, { kind: 'vitest', log: ' Tests  1 passed (1)' })).toEqual({
      verdict: pass,
    });
    expect(narrowVerdict(pass, { kind: 'vitest', log: ' Tests  1 skipped (1)' })).toMatchObject({
      verdict: { kind: 'no-verdict', reason: 'selection' },
      note: expect.stringMatching(/selected no test/),
    });
    expect(narrowVerdict(pass, { kind: 'vitest', log: '' })).toMatchObject({
      verdict: { kind: 'no-verdict', reason: 'env' },
      note: expect.stringMatching(/summary not found/),
    });
    const red = { kind: 'fail', reason: 'red' } as const;
    expect(narrowVerdict(red, { kind: 'vitest', log: '' })).toEqual({ verdict: red });
  });

  it('deadline is learned p95 x3 with a floor; no history gets the generous default', () => {
    expect(p95([])).toBeNull();
    expect(p95([5, 1, 3])).toBe(5);
    const samples = Array.from({ length: 100 }, (_, i) => (i + 1) * 1_000);
    expect(p95(samples)).toBe(95_000);
    expect(deadlineOf(samples).ms).toBe(285_000);
    expect(deadlineOf([10]).ms).toBe(MIN_DEADLINE_MS);
    expect(deadlineOf([]).ms).toBe(DEFAULT_DEADLINE_MS);
  });
});
