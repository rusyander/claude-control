import { describe, expect, it } from 'vitest';
import type {
  ProjectTestCase,
  ProjectTestGroup,
  ProjectTestRunRecord,
  ProjectTestStatus,
} from '@agentdeck/contracts';
import { codePathsOf, judgeTurn } from './turn-gate.ts';

/**
 * Пробелы хода агента: правил код — кейс есть, автоматический прогнан после
 * правки, ручной записан, красного нет (решение владельца 15.10).
 */

const SINCE = '2026-10-15T10:00:00.000Z';
const EDIT = '2026-10-15T10:05:00.000Z';
const CLI = 'node "tests-cli.mjs"';

const testCase = (id: string, extra: Partial<ProjectTestCase> = {}): ProjectTestCase =>
  ({
    id,
    type: 'case',
    title: id,
    steps: [],
    status: 'unknown',
    source: 'human',
    ...extra,
  }) as ProjectTestCase;
const auto = (id: string, codePaths: string[]) =>
  testCase(id, { codePaths, automation: { status: 'automated', file: `tests/${id}.test.ts` } });

const groups = (cases: ProjectTestCase[]): ProjectTestGroup[] => [
  { id: 'auth', title: 'Auth', file: 'auth.tests.json', cases },
];

const run = (
  startedAt: string,
  results: [string, ProjectTestStatus][],
  extra: Partial<ProjectTestRunRecord> = {},
): ProjectTestRunRecord =>
  ({
    id: `r-${startedAt}`,
    mode: 'import',
    actor: 'ci',
    status: 'done',
    startedAt,
    finishedAt: startedAt,
    results: results.map(([caseId, status]) => ({
      pointId: caseId,
      groupId: 'auth',
      caseId,
      status,
    })),
    summary: { total: results.length, passed: 0, failed: 0, skipped: 0, blocked: 0 },
    ...extra,
  }) as ProjectTestRunRecord;

const judge = (cases: ProjectTestCase[], runs: ProjectTestRunRecord[], paths: string[]) =>
  judgeTurn({
    groups: groups(cases),
    runs,
    paths,
    since: SINCE,
    changedAt: EDIT,
    cli: CLI,
    root: '/p',
  });

describe('пробелы хода агента', () => {
  it('правок кода нет (заметки, документы, замки) — пробелов нет', () => {
    expect(judge([], [], ['.agent/notes.md', 'docs/a.md', 'README.md', 'pnpm-lock.yaml'])).toEqual(
      [],
    );
  });

  it('кейс, написанный за ход, ничего не называет — пробел и без правок кода; старый и внятный — нет', () => {
    const junk = (id: string, updatedAt: string) =>
      testCase(id, {
        updatedAt,
        steps: [{ action: 'Прогнать тесты каталога src/auth', expected: 'Все проходят' }],
        expected: 'Тесты зелёные',
      });
    const named = testCase('auth-003', {
      updatedAt: EDIT,
      steps: [
        { action: 'Войти с истёкшим токеном', expected: 'Ответ 401, в теле code=token_expired' },
      ],
    });
    const cases = [junk('auth-001', EDIT), junk('auth-002', '2026-10-14T09:00:00.000Z'), named];
    const gaps = judge(cases, [], ['.agent/tests/auth.tests.json']);
    expect(gaps).toHaveLength(1);
    expect(gaps[0]).toContain('name nothing observable (auth:auth-001)');
    expect(gaps[0]).toContain('lint --project "/p"');
  });

  it('блок пуст, а код правили — пробел с готовой командой case', () => {
    const gaps = judge([], [], ['apps/server/src/auth/login.ts']);
    expect(gaps).toHaveLength(1);
    expect(gaps[0]).toContain('no test case yet');
    expect(gaps[0]).toContain('--group server');
    expect(gaps[0]).toContain('"codePaths":["apps/server/src/auth/login.ts"]');
  });

  it('изменённый файл не покрыт ни одним кейсом — пробел «add or extend»', () => {
    const gaps = judge([auto('auth-001', ['src/auth'])], [], ['src/billing/pay.ts']);
    expect(gaps.join('\n')).toContain('no case covers src/billing/pay.ts');
  });

  it('автокейс прогнан до правки — пробел; после правки зелёным — чисто', () => {
    const cases = [auto('auth-001', ['src/auth'])];
    const before = run('2026-10-15T10:01:00.000Z', [['auth-001', 'passed']]);
    expect(judge(cases, [before], ['src/auth/login.ts']).join('\n')).toContain(
      'were not run after the last edit (auth-001)',
    );
    const after = run('2026-10-15T10:06:00.000Z', [['auth-001', 'passed']]);
    expect(judge(cases, [before, after], ['src/auth/login.ts'])).toEqual([]);
  });

  it('запись словом (attested) автокейс не закрывает', () => {
    const cases = [auto('auth-001', ['src/auth'])];
    const word = run('2026-10-15T10:06:00.000Z', [['auth-001', 'passed']], {
      attested: true,
    } as Partial<ProjectTestRunRecord>);
    expect(judge(cases, [word], ['src/auth/login.ts']).join('\n')).toContain(
      'not run after the last edit',
    );
  });

  it('ручной кейс без записи за ход — пробел с командой record; запись — чисто', () => {
    const cases = [testCase('auth-002', { codePaths: ['src/auth'] })];
    expect(judge(cases, [], ['src/auth/login.ts']).join('\n')).toContain(
      'record --project "/p" auth:auth-002=passed',
    );
    const recorded = run('2026-10-15T10:06:00.000Z', [['auth-002', 'passed']], {
      attested: true,
    } as Partial<ProjectTestRunRecord>);
    expect(judge(cases, [recorded], ['src/auth/login.ts'])).toEqual([]);
  });

  it('красное за ход — пробел; в карантине — нет', () => {
    const red = run('2026-10-15T10:06:00.000Z', [['auth-001', 'failed']]);
    expect(judge([auto('auth-001', ['src/auth'])], [red], ['src/auth/a.ts']).join('\n')).toContain(
      'red this turn',
    );
    const muted = auto('auth-001', ['src/auth']);
    muted.muted = true;
    expect(judge([muted], [red], ['src/auth/a.ts']).join('\n')).not.toContain('red this turn');
  });

  it('прогон прошлого хода не засчитывается', () => {
    const old = run('2026-10-15T09:00:00.000Z', [['auth-001', 'passed']]);
    expect(judge([auto('auth-001', ['src/auth'])], [old], ['src/auth/a.ts'])).toHaveLength(1);
  });

  it('пути из Windows и с ./ приводятся к виду от корня', () => {
    expect(codePathsOf(['.\\src\\a.ts', './src/a.ts', '../outside.ts'])).toEqual(['src/a.ts']);
  });
});
