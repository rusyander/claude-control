import { describe, it, expect } from 'vitest';
import {
  applicableSieves,
  areaOf,
  BUILTIN_SIEVES,
  evidenceRunIds,
  judgeSieves,
  learnedAppliesTo,
  riskTier,
  sievePromptBlock,
  staleSieveIds,
  stampSieveRows,
  type SieveDef,
  type SieveGap,
  type SieveMechanics,
  type SieveReportRow,
} from '@agentdeck/contracts/sieves';

/**
 * Эталонный судья сит: механика панели снимается только названным файлом,
 * проверки проекта — только названной командой, доказательство — только на
 * нынешнем коде, а живая проверка в проекте с блоком «Тесты» — только
 * записанным прогоном, который панель сама открыла.
 */

const sieve = (id: string): SieveDef => BUILTIN_SIEVES.find((item) => item.id === id)!;
const codes = (gaps: SieveGap[]): string[] => gaps.map((gap) => gap.code);
const row = (
  id: string,
  evidence: string,
  extra: Partial<SieveReportRow> = {},
): SieveReportRow => ({
  id,
  status: 'pass',
  evidence,
  ...extra,
});

describe('механика панели: снимается только названным', () => {
  const flagged: [string, SieveMechanics, SieveGap['code']][] = [
    ['lockfile-sync', { lockfiles: ['web/package.json'] }, 'sieve-gap-lockfile'],
    ['secrets', { secrets: ['src/config.ts'] }, 'sieve-gap-secrets'],
    ['debug-leftovers', { debugLeftovers: ['src/a.test.ts'] }, 'sieve-gap-debug'],
    ['committed-artifacts', { artifacts: ['.env.local'] }, 'sieve-gap-artifacts'],
    ['env-config', { envVars: ['PAYMENTS_URL'] }, 'sieve-gap-env'],
  ];

  for (const [id, mechanics, code] of flagged) {
    it(`${id}: без строки — пробел; «всё ок» без имён — пробел; с именем — снято`, () => {
      expect(codes(judgeSieves({ applicable: [], rows: [], mechanics }))).toEqual([code]);
      const vague = [row(id, 'checked everything, all fine here')];
      expect(codes(judgeSieves({ applicable: [], rows: vague, mechanics }))).toEqual([code]);
      const item = Object.values(mechanics)[0]![0]!;
      const named = [
        row(id, `n/a: ${item} is a test fixture, not a real value`, { status: 'n/a' }),
      ];
      expect(judgeSieves({ applicable: [], rows: named, mechanics })).toEqual([]);
    });
  }

  // Ревью PR #1: имя внутри другого имени — не то имя.
  it('имя внутри другого — не названо: src/data.ts не снимает src/a.ts, FOOBAR — FOO', () => {
    const other = (id: string, evidence: string, mechanics: SieveMechanics) =>
      codes(
        judgeSieves({ applicable: [], rows: [row(id, evidence, { status: 'n/a' })], mechanics }),
      );
    expect(
      other('secrets', 'n/a: src/data.ts is a test fixture', { secrets: ['src/a.ts'] }),
    ).toEqual(['sieve-gap-secrets']);
    expect(other('env-config', 'n/a: FOOBAR is documented', { envVars: ['FOO'] })).toEqual([
      'sieve-gap-env',
    ]);
    // Путь в кавычках, с ./ или под абсолютным корнем — по-прежнему назван.
    expect(
      other('secrets', 'n/a: `./src/a.ts` holds a test fixture', { secrets: ['src/a.ts'] }),
    ).toEqual([]);
  });

  it('fail по механике не снимает срабатывание, даже с именем файла', () => {
    const gaps = judgeSieves({
      applicable: [],
      rows: [row('secrets', 'src/config.ts has a live key', { status: 'fail' })],
      mechanics: { secrets: ['src/config.ts'] },
    });
    expect(codes(gaps)).toEqual(['sieve-gap-secrets']);
  });

  it('код без тестов снимается любым доказательством — какой тест его покрывает', () => {
    const mechanics = { untestedCode: ['src/api.ts'] };
    expect(codes(judgeSieves({ applicable: [], rows: [], mechanics }))).toEqual([
      'sieve-gap-untested',
    ]);
    const covered = [row('tests-alongside', 'covered by e2e/api.spec.ts [api-003] → passed')];
    expect(judgeSieves({ applicable: [], rows: covered, mechanics })).toEqual([]);
  });

  it('механика без срабатывания строки не требует', () => {
    const applicable = applicableSieves(['README.md']);
    const gaps = judgeSieves({
      applicable,
      rows: [row('contract-by-request', 'curl /api/x → 404 as documented in README')],
      mechanics: {},
    });
    expect(gaps).toEqual([]);
  });
});

describe('проверки проекта: названа каждая команда', () => {
  const applicable = [sieve('project-checks')];
  const mechanics = {
    checks: [
      { command: 'pnpm lint', aliases: ['pnpm run lint'] },
      { command: 'pnpm test', aliases: ['pnpm run test'] },
    ],
  };

  it('пропущенная команда — пробел с её именем', () => {
    const gaps = judgeSieves({
      applicable,
      rows: [row('project-checks', 'pnpm lint → 0 problems')],
      mechanics,
    });
    expect(gaps).toEqual([
      { code: 'sieve-gap-checks', params: { sieve: 'project-checks', commands: 'pnpm test' } },
    ]);
  });

  it('синоним засчитывается; «test» внутри другого слова — нет', () => {
    const ok = judgeSieves({
      applicable,
      rows: [row('project-checks', 'pnpm run lint → clean; pnpm test → 214 passed')],
      mechanics,
    });
    expect(ok).toEqual([]);
    const vague = judgeSieves({
      applicable,
      rows: [row('project-checks', 'pnpm lint clean, tested manually')],
      mechanics,
    });
    expect(codes(vague)).toEqual(['sieve-gap-checks']);
  });

  it('n/a при найденных командах — пробел: не запустилось — это fail с причиной', () => {
    const gaps = judgeSieves({
      applicable,
      rows: [row('project-checks', 'n/a: no time to run them all', { status: 'n/a' })],
      mechanics,
    });
    expect(gaps[0]?.params.commands).toBe('pnpm lint, pnpm test');
  });
});

describe('миграции: разрушающий оператор назван по файлу', () => {
  it('без имени файла — пробел; с именем — снято', () => {
    const applicable = [sieve('migration-safety')];
    const mechanics = { destructive: ['db/migrations/0042_drop_legacy.sql'] };
    const vague = judgeSieves({
      applicable,
      rows: [row('migration-safety', 'migrate up/down on a schema copy → ok')],
      mechanics,
    });
    expect(codes(vague)).toEqual(['sieve-gap-destructive']);
    const named = judgeSieves({
      applicable,
      rows: [
        row(
          'migration-safety',
          '0042_drop_legacy.sql: column copied to new_col first; migrate down restores it → ok',
        ),
      ],
      mechanics,
    });
    expect(named).toEqual([]);
  });
});

describe('свежесть: строка считается для кода, на котором сдана', () => {
  const applicable = [sieve('browser-focus')];
  const rows = [
    row('browser-focus', 'npx playwright test focus → 3 passed', { at: '2026-09-30T10:00:00Z' }),
  ];

  it('после сдачи меняли интерфейс — устарела', () => {
    const gaps = judgeSieves({
      applicable,
      rows,
      mechanics: {},
      proof: { changedAfterRow: { 'browser-focus': ['src/Page.tsx', 'README.md'] } },
    });
    expect(gaps).toEqual([
      { code: 'sieve-gap-stale', params: { sieve: 'browser-focus', files: 'src/Page.tsx' } },
    ]);
  });

  it('после сдачи меняли только тесты и доки — строка в силе', () => {
    const gaps = judgeSieves({
      applicable,
      rows,
      mechanics: {},
      proof: { changedAfterRow: { 'browser-focus': ['e2e/focus.spec.ts', 'README.md'] } },
    });
    expect(gaps).toEqual([]);
  });

  it('устаревшие сита в задании делаются заново, а не считаются сданными', () => {
    const stale = staleSieveIds(applicable, { 'browser-focus': ['src/Page.tsx'] });
    expect(stale).toEqual(['browser-focus']);
    const block = sievePromptBlock({ stage: 'deliver', applicable, done: rows, stale });
    expect(block).toContain('[browser-focus] (again');
  });

  it('штамп ставит панель, а не модель', () => {
    expect(stampSieveRows([row('x', 'evidence text here')], '2026-09-30T10:00:00Z')[0]?.at).toBe(
      '2026-09-30T10:00:00Z',
    );
  });
});

describe('доказательство прогоном блока «Тесты»', () => {
  const applicable = [sieve('boundary-negative')];
  const judge = (evidence: string, proof: Parameters<typeof judgeSieves>[0]['proof']) =>
    judgeSieves({ applicable, rows: [row('boundary-negative', evidence)], mechanics: {}, proof });

  it('ссылки run:<id> вынимаются из текста', () => {
    expect(evidenceRunIds('POST max+1 → 400; run:3f2a9c1e-77 and run: abcdef12')).toEqual([
      '3f2a9c1e-77',
      'abcdef12',
    ]);
  });

  it('блока нет — слов достаточно, как раньше', () => {
    expect(
      judge('POST /api/name with 256 chars → 400 NAME_TOO_LONG', { testsBlock: false }),
    ).toEqual([]);
  });

  it('блок есть, ссылки нет — пробел', () => {
    expect(codes(judge('POST max+1 → 400 as documented', { testsBlock: true }))).toEqual([
      'sieve-gap-no-run',
    ]);
  });

  it('прогона нет, он красный или старше правки — пробел с причиной', () => {
    const evidence = 'POST max+1 → 400, recorded run:run-000001';
    expect(codes(judge(evidence, { testsBlock: true, runs: {} }))).toEqual([
      'sieve-gap-run-missing',
    ]);
    const red = { found: true, red: ['forms-004'], changedAfter: [] };
    expect(judge(evidence, { testsBlock: true, runs: { 'run-000001': red } })[0]).toEqual({
      code: 'sieve-gap-run-red',
      params: { sieve: 'boundary-negative', run: 'run-000001', cases: 'forms-004' },
    });
    const old = { found: true, red: [], changedAfter: ['src/forms/limit.ts'] };
    expect(codes(judge(evidence, { testsBlock: true, runs: { 'run-000001': old } }))).toEqual([
      'sieve-gap-run-stale',
    ]);
  });

  it('годный прогон снимает; одного годного среди нескольких хватает', () => {
    const good = { found: true, red: [], changedAfter: ['e2e/forms.spec.ts'] };
    const bad = { found: false, red: [], changedAfter: [] };
    expect(
      judge('max+1 → 400 run:run-000002 (earlier run:run-000001)', {
        testsBlock: true,
        runs: { 'run-000001': bad, 'run-000002': good },
      }),
    ).toEqual([]);
  });

  it('n/a живой проверки прогона не требует', () => {
    const gaps = judgeSieves({
      applicable,
      rows: [row('boundary-negative', 'n/a: only a comment changed', { status: 'n/a' })],
      mechanics: {},
      proof: { testsBlock: true },
    });
    expect(gaps).toEqual([]);
  });
});

describe('риск и план отката', () => {
  it('миграция, путь входа или денег и крупный дифф — высокий риск с причиной', () => {
    expect(riskTier(['db/migrations/0042_add.sql'])).toEqual({ tier: 'high', reasons: ['data'] });
    expect(riskTier(['src/auth/token.ts']).reasons).toEqual(['sensitive: src/auth/token.ts']);
    expect(riskTier(['services/billing/charge.go']).tier).toBe('high');
    const many = Array.from({ length: 40 }, (_, index) => `src/m${index}.ts`);
    expect(riskTier(many).reasons).toEqual(['size: 40']);
  });

  it('обычный код — средний; только доки и тесты — низкий', () => {
    expect(riskTier(['src/list.ts']).tier).toBe('medium');
    expect(riskTier(['README.md', 'src/auth/login.test.ts']).tier).toBe('low');
  });

  it('план отката применим только на высоком риске', () => {
    const ids = (paths: string[]) => applicableSieves(paths).map((item) => item.id);
    expect(ids(['src/auth/session.ts'])).toContain('rollback-plan');
    expect(ids(['src/list.ts'])).not.toContain('rollback-plan');
    expect(ids(['db/migrations/0042_add.sql'])).toContain('migration-safety');
  });

  it('высокий риск назван в задании', () => {
    const paths = ['src/payments/refund.ts'];
    const block = sievePromptBlock({
      stage: 'deliver',
      applicable: applicableSieves(paths),
      risk: riskTier(paths),
    });
    expect(block).toContain('HIGH risk (sensitive: src/payments/refund.ts)');
    expect(block).toContain('[rollback-plan]');
  });
});

describe('задание: команды проекта и доказательство прогоном', () => {
  it('найденные команды названы, а живые сита просят run:<id>', () => {
    const block = sievePromptBlock({
      stage: 'deliver',
      applicable: applicableSieves(['src/Page.tsx']),
      mechanics: { checks: [{ command: 'pnpm lint' }, { command: 'pnpm test' }] },
      testsBlock: true,
    });
    expect(block).toContain('pnpm lint ; pnpm test');
    expect(block).toMatch(/for [^.]*browser-focus[^.]* record the live check/);
    expect(block).toContain('run:<id>');
    expect(block).toContain('A row counts for the code it was written on');
  });
});

describe('выученные сита по областям', () => {
  it('область — два первых каталога пути', () => {
    expect(areaOf('apps/server/src/routes/chat.ts')).toBe('apps/server');
    expect(areaOf('src/api.ts')).toBe('src');
    expect(areaOf('main.go')).toBe('');
  });

  it('проектное сито с областью — только если дифф её задел; общее — всегда', () => {
    const scoped = { scope: 'project' as const, areas: ['apps/server'] };
    expect(learnedAppliesTo(scoped, ['apps/server/src/a.ts'])).toBe(true);
    expect(learnedAppliesTo(scoped, ['apps/web/src/a.tsx'])).toBe(false);
    expect(learnedAppliesTo({ scope: 'global', areas: ['apps/server'] }, ['x/y.ts'])).toBe(true);
    expect(learnedAppliesTo({ scope: 'project' }, ['x/y.ts'])).toBe(true);
  });
});

describe('задание показывает ровно то, что потребует судья (Ф1, Ф2)', () => {
  it('строка, которую судья отклонит, в задании открыта; принятая — нет', () => {
    const applicable = [sieve('boundary-negative'), sieve('project-checks')];
    const mechanics: SieveMechanics = {
      checks: [{ command: 'pnpm lint' }, { command: 'pnpm test' }],
    };
    const done = [
      // Длинное доказательство без run:<id> в проекте с блоком «Тесты» — судья: no-run.
      row('boundary-negative', 'POST max+1 → 400 as documented, checked by hand'),
      // Названа одна команда из двух — судья: sieve-gap-checks.
      row('project-checks', 'pnpm lint → 0 problems, all green'),
    ];
    const proof = { testsBlock: true };
    const gaps = judgeSieves({ applicable, rows: done, mechanics, proof });
    expect(codes(gaps).sort()).toEqual(['sieve-gap-checks', 'sieve-gap-no-run']);
    const block = sievePromptBlock({ stage: 'deliver', applicable, done, mechanics, proof });
    expect(block).toContain('[boundary-negative]');
    expect(block).toContain('[project-checks]');

    const fixed = [
      row('boundary-negative', 'POST max+1 → 400, recorded run:run-000001'),
      row('project-checks', 'pnpm lint → 0 problems; pnpm test → 12 passed'),
    ];
    const runs = { 'run-000001': { found: true, red: [], passed: 3, changedAfter: [] } };
    const good = { testsBlock: true, runs };
    expect(judgeSieves({ applicable, rows: fixed, mechanics, proof: good })).toEqual([]);
    const after = sievePromptBlock({
      stage: 'deliver',
      applicable,
      done: fixed,
      mechanics,
      proof: good,
    });
    expect(after).not.toContain('[boundary-negative]');
    expect(after).not.toContain('[project-checks]');
  });

  it('25 отмеченных файлов: задание называет все, судья принимает ровно показанное', () => {
    const files = Array.from({ length: 25 }, (_, index) => `src/mod${index}/config.ts`);
    const mechanics: SieveMechanics = { secrets: files };
    const applicable = applicableSieves(files);
    const block = sievePromptBlock({ stage: 'deliver', applicable, mechanics });
    for (const file of files) expect(block).toContain(file);
    const shown = /\[secrets\][^:]*: ([^\n]*)\./.exec(block)?.[1] ?? '';
    const all = row('secrets', `test fixtures, not keys: ${shown}`, { status: 'n/a' });
    const gapsOf = (evidence: SieveReportRow) =>
      codes(judgeSieves({ applicable, rows: [evidence], mechanics })).filter(
        (code) => code === 'sieve-gap-secrets',
      );
    expect(gapsOf(all)).toEqual([]);
    const ten = row('secrets', `test fixtures: ${files.slice(0, 10).join(', ')}`, {
      status: 'n/a',
    });
    expect(gapsOf(ten)).toEqual(['sieve-gap-secrets']);
  });
});

describe('снятие механики устаревает правкой отмеченного (Ф5)', () => {
  const mechanics: SieveMechanics = { envVars: ['PAYMENTS_URL'], lockfiles: ['web/package.json'] };
  const rows = [
    row('env-config', 'PAYMENTS_URL is set by the deploy chart', { at: '2026-10-01T10:00:00Z' }),
    row('lockfile-sync', 'web/package.json only reorders scripts', { at: '2026-10-01T10:00:00Z' }),
  ];
  const judge = (changed: Record<string, string[]>) =>
    judgeSieves({ applicable: [], rows, mechanics, proof: { changedAfterRow: changed } });

  it('после снятия правили чужое или доки — снято; правили отмеченное — снова открыто', () => {
    expect(judge({ 'env-config': ['README.md'], 'lockfile-sync': ['web/src/a.ts'] })).toEqual([]);
    expect(judge({ 'env-config': ['src/pay.ts'], 'lockfile-sync': ['web/package.json'] })).toEqual([
      { code: 'sieve-gap-stale', params: { sieve: 'lockfile-sync', files: 'web/package.json' } },
      { code: 'sieve-gap-stale', params: { sieve: 'env-config', files: 'src/pay.ts' } },
    ]);
  });
});
