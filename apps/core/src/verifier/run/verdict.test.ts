import { describe, expect, it } from 'vitest';
import { testsRan } from './failing.ts';
import { failedCountOf, narrowVerdict } from './verdict.ts';

/**
 * Узкий прогон, выборка которого не нашла ни одного теста, — не красный (A1r3-F05): Gradle, Maven,
 * jest, playwright, vitest и pytest сами выходят с ненулевым кодом, когда фильтр пуст. Это дело
 * привязки (`selection`), а «две красных → fail» на пустой выборке хоронило флаки и красное-до.
 */

const red = { kind: 'fail', reason: 'red' } as const;

describe('narrow verdict: the runner own «no test matched» exit is no-verdict(selection), never red', () => {
  it('A1r3-F05 each runner empty-selection line on a non-zero exit is selection, named in the note', () => {
    const table: [Parameters<typeof narrowVerdict>[1] & object, string][] = [
      [
        {
          kind: 'gradle',
          log: "> Task :test FAILED\n\nFAILURE: Build failed with an exception.\n* What went wrong:\nExecution failed for task ':test'.\n> No tests found for given includes: [com.x.CalcTest.addsTwo](--tests filter)\n",
        },
        'gradle',
      ],
      [
        {
          kind: 'maven',
          log: '[ERROR] Failed to execute goal org.apache.maven.plugins:maven-surefire-plugin:3.2.5:test (default-test) on project core: No tests matching pattern "a.b.CalcTest#adds" were executed! (Set -Dsurefire.failIfNoSpecifiedTests=false to ignore this error.)\n',
        },
        'maven',
      ],
      [{ kind: 'jest', log: 'No tests found, exiting with code 1\n' }, 'jest'],
      [{ kind: 'playwright', log: 'Error: No tests found\n' }, 'playwright'],
      [{ kind: 'vitest', log: 'No test files found, exiting with code 1\n' }, 'vitest'],
      [{ kind: 'pytest', log: '====== 5 deselected in 0.02s ======\n' }, 'pytest'],
    ];
    for (const [narrowed, kind] of table)
      expect({ kind, got: narrowVerdict(red, narrowed) }).toMatchObject({
        kind,
        got: {
          verdict: { kind: 'no-verdict', reason: 'selection' },
          note: expect.stringMatching(/selected no test/),
        },
      });
  });

  it('a real failure stays red even when the same log names an empty selection elsewhere', () => {
    // Многомодульная сборка: в одном модуле тест упал на утверждении — это красный, не выборка.
    const log =
      '[ERROR] a.b.CalcTest.adds -- Time elapsed: 0.1 s <<< FAILURE!\n[ERROR] No tests matching pattern "a.b.CalcTest#adds" were executed!\n';
    expect(narrowVerdict(red, { kind: 'maven', log })).toEqual({ verdict: red });
    // Ошибка сбора pytest (exit 2) — красный, не «пустая выборка».
    expect(narrowVerdict(red, { kind: 'pytest', log: '=== 1 error in 0.10s ===\n' })).toEqual({
      verdict: red,
    });
    // Не узкий прогон — исход как есть.
    expect(narrowVerdict(red, null)).toEqual({ verdict: red });
  });

  it('maven summary, when printed, counts executed tests; «No tests to run» is 0; without either — doubt, never «ran»', () => {
    expect(
      testsRan(
        'maven',
        '[INFO] Tests run: 0, Failures: 0, Errors: 0, Skipped: 0\n[INFO] BUILD SUCCESS\n',
      ),
    ).toBe(0);
    expect(
      testsRan(
        'maven',
        '[INFO] Tests run: 1, Failures: 0, Errors: 0, Skipped: 0, Time elapsed: 0.1 s - in a.b.X\n[INFO] Tests run: 1, Failures: 0, Errors: 0, Skipped: 0\n',
      ),
    ).toBe(1);
    // Узкий maven идёт с failIfNoSpecifiedTests=false: пустая выборка выходит с 0, итога нет.
    expect(testsRan('maven', '[INFO] No tests to run.\n[INFO] BUILD SUCCESS\n')).toBe(0);
    expect(testsRan('maven', '')).toBeNull();
  });
});

describe('failed count from the runner own summary (A1r2-F04)', () => {
  it('each runner summary gives the failed count; no summary is undefined, never a guess', () => {
    const table: [Parameters<typeof failedCountOf>[1], string, number | undefined][] = [
      ['vitest', ' Test Files  1 failed (1)\n      Tests  2 failed | 3 passed (5)\n', 2],
      ['jest', 'Tests:       1 failed, 4 passed, 5 total\n', 1],
      ['playwright', '  3 failed\n    [chromium] › a.spec.ts:3:1 › x\n  7 passed (4.1s)\n', 3],
      ['pytest', '==== 2 failed, 1 passed, 1 error in 0.31s ====\n', 3],
      ['cargo', 'test result: FAILED. 4 passed; 2 failed; 0 ignored\n', 2],
      ['dotnet', 'Failed!  - Failed:     2, Passed:     5, Skipped:     0, Total:     7\n', 2],
      [
        'maven',
        'Tests run: 3, Failures: 1, Errors: 0, Skipped: 0, Time elapsed: 0.1 s <<< FAILURE! - in a.ATest\n' +
          'Tests run: 9, Failures: 1, Errors: 1, Skipped: 0\n',
        2,
      ],
      ['gradle', '5 tests completed, 2 failed\n', 2],
      // Без -v у go числа упавших нет — независимого итога нет.
      ['go', '--- FAIL: TestA (0.00s)\nFAIL\tpkg\t0.1s\n', undefined],
      ['vitest', 'Error: config broke before any test\n', undefined],
    ];
    for (const [kind, log, want] of table)
      expect([kind, failedCountOf('exit', kind, log)]).toEqual([kind, want]);
    // Прогон, не дошедший до выхода, итога не даёт.
    expect(failedCountOf('deadline', 'vitest', ' Tests  2 failed (2)\n')).toBeUndefined();
  });
});
