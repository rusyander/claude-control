import type { CheckEntry } from '@agentdeck/contracts/core/records';
import { describe, expect, it } from 'vitest';
import { argvFor, expandTemplate, selectionArgs } from './argv.ts';
import { parseFailing } from './failing.ts';

/**
 * Узкий перепрогон в форме, которую раннер действительно сверяет (A1r3-F05/F06, B1r3-F04): имя
 * приходит из разбора упавших (`parseFailing`) — та же цепочка, что у повтора флаки и красного-до.
 */

const BASE: CheckEntry = {
  id: 'x',
  class: 'test-runner',
  argv: ['run'],
  cwd: '',
  unit: 'project',
  requiredAt: ['publish'],
  baseDependent: false,
  inputs: [],
  envAllow: [],
  tools: [],
  artifacts: [],
  needs: [],
  source: 'detected',
};

describe('narrow rerun argv (A1r3-F05, A1r3-F06, B1r3-F04)', () => {
  it('A1r3-F05 gradle: a JUnit 5 failing line becomes Cls.method (no parens, nested Outer$Inner, params dropped)', () => {
    const log = [
      'com.x.CalcTest > addsTwo() FAILED',
      'com.x.CalcTest > Nested > inner() FAILED',
      'com.x.CalcTest > adds(int, String) > [1] 1, a FAILED',
      'com.x.LegacyTest > testOld FAILED',
      'com.x.LegacyTest > testParam[0] FAILED',
    ].join('\n');
    const names = parseFailing('gradle', log).map((f) => f.name);
    expect(names.map((n) => selectionArgs('gradle', [n]))).toEqual([
      ['com.x.CalcTest.addsTwo'],
      ['com.x.CalcTest$Nested.inner'],
      ['com.x.CalcTest.adds'],
      ['com.x.LegacyTest.testOld'],
      ['com.x.LegacyTest.testParam'],
    ]);
    // Имя показа (@DisplayName с пробелами) класса раннера не называет — вся единица, честно.
    expect(selectionArgs('gradle', ['com.x.CalcTest > adds two numbers'])).toBeNull();
  });

  it('A1r3-F05 maven: a JUnit 5 parameterised name loses (args)[n]; the old form method(Cls) still maps', () => {
    expect(
      selectionArgs('maven', [
        'a.b.CalcTest.adds(int)[1]',
        'a.b.CalcTest$Inner.inner',
        'm2(a.b.Cls)',
      ]),
    ).toEqual(['a.b.CalcTest#adds,a.b.CalcTest$Inner#inner,a.b.Cls#m2']);
  });

  it('A1r3-F06 go: a project-unit narrow rerun reaches every package (./...), not only the root', () => {
    const go: CheckEntry = {
      ...BASE,
      argv: ['go', 'test', './...'],
      filter: { kind: 'go', argv: ['go', 'test', '{units}', '-run', '{tests}'] },
    };
    expect(argvFor(go, { unit: '.', selection: ['TestSub'], base: null, files: [] })).toEqual({
      argv: ['go', 'test', './...', '-run', '^(?:TestSub)$'],
      narrowed: true,
    });
    // Без выборки — полный argv записи, как был.
    expect(argvFor(go, { unit: '.', selection: [], base: null, files: [] }).argv).toEqual([
      'go',
      'test',
      './...',
    ]);
  });

  it('B1r3-F04 a test name or path starting with «-» never becomes a runner flag', () => {
    for (const kind of ['vitest', 'jest', 'playwright', 'gradle', 'cargo', 'go'] as const)
      expect({ kind, got: selectionArgs(kind, ['--config=build.rustc-wrapper=x']) }).toEqual({
        kind,
        got: null,
      });
    expect(
      expandTemplate(['run', '{files}', '{units}'], {
        unit: '-rf',
        selection: [],
        base: null,
        files: ['-x.ts', 'ok.ts'],
      }),
    ).toEqual(['run', './-x.ts', 'ok.ts', './-rf']);
  });

  it('repo-relative {files} are rebased to the entry cwd; the repo root cwd keeps them as is', () => {
    const vitest = (cwd: string): CheckEntry => ({
      ...BASE,
      cwd,
      filter: { kind: 'vitest', argv: ['vitest', 'run', '{files}', '-t', '{tests}'] },
    });
    const input = {
      unit: 'a',
      selection: ['m > t'],
      base: null,
      files: ['packages/a/src/x.test.ts', 'packages/b/y.test.ts'],
    };
    expect(argvFor(vitest('packages/a'), input).argv).toEqual([
      'vitest',
      'run',
      'src/x.test.ts',
      '../b/y.test.ts',
      '-t',
      'm(?: > | )t',
    ]);
    expect(argvFor(vitest(''), input).argv.slice(2, 4)).toEqual(input.files);
  });

  it('filesFrom unit: {files} are rebased to the unit dir; no unit dir drops the files, the name selection stays', () => {
    // Член воркспейса: запись идёт из корня, раннер — из каталога члена за селектором пакета.
    const member: CheckEntry = {
      ...BASE,
      filter: {
        kind: 'vitest',
        argv: ['pnpm', '--filter', '{units}', 'exec', 'vitest', 'run', '{files}', '-t', '{tests}'],
        filesFrom: 'unit',
      },
    };
    const input = {
      unit: 'a',
      selection: ['m > t'],
      base: null,
      files: ['packages/a/src/x.test.ts'],
    };
    expect(argvFor(member, { ...input, unitDir: 'packages/a' }).argv).toEqual([
      'pnpm',
      '--filter',
      'a',
      'exec',
      'vitest',
      'run',
      'src/x.test.ts',
      '-t',
      'm(?: > | )t',
    ]);
    // Путь от корня в каталоге члена не нашёл бы ничего: без каталога единицы файлов нет.
    expect(argvFor(member, input)).toEqual({
      argv: ['pnpm', '--filter', 'a', 'exec', 'vitest', 'run', '-t', 'm(?: > | )t'],
      narrowed: true,
    });
  });
});
