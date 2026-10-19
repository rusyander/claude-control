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
  /**
   * 3.4 плана экономии: одноразовый скрипт снимков блокировал конец хода словами
   * «no case covers e2e/…-shots.mjs». Скрипт снимков или пробы, которого git не
   * отслеживает, — подсобка хода, как `.agent/`; отслеживаемый, тест или
   * обычный новый файл — код.
   */
  it('неотслеживаемый скрипт снимков или пробы — не код; отслеживаемый и новый исходник — код', () => {
    const scratch = ['e2e/login-shots.mjs', 'tools/probe-auth.ts', 'scripts/screenshots.py'];
    const quiet = judgeTurn({
      groups: groups([]),
      runs: [],
      paths: scratch,
      untracked: scratch,
      since: SINCE,
      changedAt: EDIT,
      cli: CLI,
      root: '/p',
    });
    expect(quiet).toEqual([]);
    const tracked = judge([], [], ['e2e/login-shots.mjs']);
    expect(tracked.join(String.fromCharCode(10))).toContain('no test case yet');
    const fresh = judgeTurn({
      groups: groups([]),
      runs: [],
      paths: ['src/login.ts', 'e2e/login-shots.spec.ts'],
      untracked: ['src/login.ts', 'e2e/login-shots.spec.ts'],
      since: SINCE,
      changedAt: EDIT,
      cli: CLI,
      root: '/p',
    });
    expect(fresh.join(String.fromCharCode(10))).toContain('src/login.ts, e2e/login-shots.spec.ts');
  });

  /** Ревью B2-F1: имя «probe/snapshot/screenshot» у нового исходника продукта не снимает проверку. */
  it('новый исходник с «пробным» именем вне папки скриптов — код', () => {
    const source = [
      'src/health/probe.ts',
      'shared/lib/screenshot.ts',
      'apps/web/src/e2e/snapshot.ts',
      'services/readiness-probes.py',
    ];
    const gaps = judgeTurn({
      groups: groups([]),
      runs: [],
      paths: [...source, 'probe-auth.mjs'],
      untracked: [...source, 'probe-auth.mjs'],
      since: SINCE,
      changedAt: EDIT,
      cli: CLI,
      root: '/p',
    }).join(String.fromCharCode(10));
    expect(gaps).toContain(
      'src/health/probe.ts, shared/lib/screenshot.ts, apps/web/src/e2e/snapshot.ts, services/readiness-probes.py',
    );
    expect(gaps).not.toContain('(+1)');
    // Скрипт пробы в корне — подсобка хода.
    expect(
      judgeTurn({
        groups: groups([]),
        runs: [],
        paths: ['probe-auth.mjs'],
        untracked: ['probe-auth.mjs'],
        since: SINCE,
        changedAt: EDIT,
        cli: CLI,
        root: '/p',
      }),
    ).toEqual([]);
  });

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

  it('папка в codePaths с косой чертой на конце покрывает свои файлы', () => {
    const after = run('2026-10-15T10:06:00.000Z', [['help-001', 'passed']]);
    const cases = [auto('help-001', ['public/help/', '.\\src\\help\\'])];
    expect(judge(cases, [after], ['public/help/phone/01.png', 'src/help/a.ts'])).toEqual([]);
  });

  it('автокейс прогнан до правки — пробел; после правки зелёным — чисто', () => {
    const cases = [auto('auth-001', ['src/auth'])];
    const before = run('2026-10-15T10:01:00.000Z', [['auth-001', 'passed']]);
    const gap = judge(cases, [before], ['src/auth/login.ts']).join('\n');
    expect(gap).toContain('were not run after the last edit (auth-001)');
    // L6.2: команда называет кейсы, не группу — группа может нести живые QA.
    expect(gap).toMatch(/run --project "\/p" --case auth:auth-001$/);
    expect(gap).not.toContain('--group');
    const after = run('2026-10-15T10:06:00.000Z', [['auth-001', 'passed']]);
    expect(judge(cases, [before, after], ['src/auth/login.ts'])).toEqual([]);
  });

  it('конец хода требует не больше 5 кейсов, самые узкие первыми, и без кейсов по зоне-слову', () => {
    // 19.10: правка run-routes.ts требовала 48 кейсов — папки и зоны размножали требование.
    const wide = Array.from({ length: 8 }, (_, i) => auto(`wide-00${i}`, ['src']));
    const exact = auto('auth-009', ['src/auth/login.ts']);
    const byArea = testCase('area-001', {
      area: 'auth',
      automation: { status: 'automated', file: 'x.test.ts' },
    });
    const gap = judge([...wide, exact, byArea], [], ['src/auth/login.ts']).join('\n');
    const command = gap.match(/--case (\S+)/)?.[1] ?? '';
    expect(command.split(',')).toHaveLength(5);
    expect(command.startsWith('auth:auth-009,')).toBe(true);
    expect(command).not.toContain('area-001');
  });

  it('ход группы (deferRuns): прогон автокейса не требуется, кейс, ручная запись и красное — требуются', () => {
    // Пункт A 19.10: 879 прогонов блока за три дня — группа прогоняет их перед «доставлено».
    const deferred = (cases: ProjectTestCase[], runs: ProjectTestRunRecord[], paths: string[]) =>
      judgeTurn({
        groups: groups(cases),
        runs,
        paths,
        since: SINCE,
        changedAt: EDIT,
        cli: CLI,
        root: '/p',
        deferRuns: true,
      });
    const cases = [
      auto('auth-001', ['src/auth']),
      testCase('auth-002', { codePaths: ['src/auth'] }),
    ];
    const gap = deferred(cases, [], ['src/auth/login.ts']).join('\n');
    expect(gap).not.toContain('not run after the last edit');
    expect(gap).toContain('record --project "/p" auth:auth-002=passed');
    expect(deferred(cases, [], ['src/billing/pay.ts']).join('\n')).toContain('no case covers');
    const red = run('2026-10-15T10:06:00.000Z', [['auth-001', 'failed']]);
    expect(deferred([cases[0]!], [red], ['src/auth/a.ts']).join('\n')).toContain('red this turn');
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
