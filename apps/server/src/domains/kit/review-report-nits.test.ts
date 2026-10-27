import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { builtinKitDir } from './service.ts';

/**
 * Страж отчёта ревью набора — настоящий файл набора. Замер стадии ревью g8 (26.10): §6 report-shape
 * велел мелочи «компактно», страж читал только заголовки `### F-NN`; отчёт по документу отклонён
 * «Summary says 🟢 15, the file has 0» и переписан (+~3 тыс. знаков, ~60 с). Строка журнала
 * печатала запланированные раунды вместо прошедших, а оценки покрытия при двух полосах не было.
 */

interface Finding {
  id: string;
  compact?: boolean;
  where: boolean;
  axis: string | null;
  status: string | null;
  statusAt: number;
  whereEnd: number;
  thread: boolean;
  locs: { file: string; from: number; to: number }[];
}
interface Parsed {
  findings: Finding[];
  bySeverity: Record<string, number>;
  coverageGap: boolean;
}
interface ReviewReport {
  parseReport: (text: string) => Parsed;
  scoreLines: (p: Parsed) => { itog: string; score: string };
  writeProblems: (text: string) => string[];
  shapeProblems: (text: string) => string[];
}

const KIT = builtinKitDir();
const report = (await import(
  pathToFileURL(join(KIT, 'hooks', 'lib', 'review-report.mjs')).href
)) as ReviewReport;

const finding = (id: string, marks: string): string =>
  `## ${id} ${marks} thesis\n\n- **Where:** \`src/a.ts:1\`\n- **Axis:** correctness\n` +
  `- **Evidence (L1 — run):** \`src/a.ts:1\` — quoted line\n- **Status:** open\n`;
const NIT =
  '- F-03 🟢 `data` says nothing — **Where:** `src/b.ts:3` · **Axis:** style · **Status:** open';
const head = (ledger: string, coverage: string, green: number): string =>
  [
    '# Review: MR !1 — base abc',
    '',
    '**Tier:** T2 — lifted by: access',
    '**Radius:** consumers 10 · entry points 5 · over the cap 0',
    '**Verified:** `node test.mjs` — 26/26',
    '**Live:** role without the right — 403; empty state — placeholder',
    '**Classes:** siblings — rg 0 · parity — 3 · hang — n/a · before gate — n/a · environment — n/a · contract — openapi.yaml:40',
    coverage,
    '**Passes:** promises — a · config — b · parse — c · registries — d · deviance — e · claims — f · history — g · attacker — h',
    '**Acceptance:** criteria 4 · met 3 · partly 1',
    ledger,
    '**Taken on trust:** none',
    `**Summary:** 🔴 1 · 🟡 1 · 🟢 ${green} — blocking: F-01`,
    `**Score:** raised ${2 + green + 1} · published 0 · confirmed by author 0`,
  ].join('\n');
const LEDGER = '**Ledger:** 12/12 files · lanes 2 · rounds 1 of 1';
const COVER = '**Coverage:** app fully · lib fully · radius 10/10 · lanes 2 — found 4, estimate ≈5';
const doc = (ledger = LEDGER, coverage = COVER, nits: string[] = [NIT]): string =>
  [
    head(ledger, coverage, nits.length),
    '',
    '## What was checked',
    '',
    '- ✗ candidate: a race — refuted by a run',
    '',
    finding('F-01', '🔴'),
    finding('F-02', '🟡'),
    '## Nits',
    '',
    ...nits,
    '',
  ].join('\n');

describe('review-report набора: мелочь одной строкой (g8 P5)', () => {
  it('мелочь одной строкой — находка с полями из строки, отчёт по документу проходит', () => {
    const text = doc();
    const p = report.parseReport(text);
    const nit = p.findings.find((f) => f.id === 'F-03');
    expect(p.bySeverity['🟢']).toBe(1);
    expect(nit).toMatchObject({ compact: true, where: true, axis: 'style', status: 'open' });
    expect(nit?.locs[0]).toEqual({ file: 'src/b.ts', from: 3, to: 3 });
    // review-sync переключает статус и вставляет «Thread» по этим индексам — строка самой мелочи.
    expect(text.split('\n')[nit?.statusAt ?? -1]).toBe(NIT);
    expect(nit?.whereEnd).toBe(nit?.statusAt);
    expect(report.writeProblems(text)).toEqual([]);
  });

  it('строка «Thread» под мелочью — её публикация', () => {
    const p = report.parseReport(doc(LEDGER, COVER, [NIT, '- **Thread:** https://g/x#note_9']));
    expect(p.findings.find((f) => f.id === 'F-03')?.thread).toBe(true);
  });

  it('мелочь без полей считается в Summary и отклоняется с точной формой строки', () => {
    const problems = report.writeProblems(
      doc(LEDGER, COVER, ['- F-03 🟢 check.mjs:1199 — vague name']),
    );
    const all = problems.join(' · ');
    expect(all).not.toContain('the file has');
    expect(all).toContain('F-03 — a one-line 🟢 carries its fields inline');
    expect(all).toContain('**Status:** open');
  });

  it('🔴/🟡/❓ одной строкой — по-прежнему не находка', () => {
    const red = report.shapeProblems(
      '## Findings\n- F-01 🟡 thesis — **Where:** `a.ts:1` · **Axis:** x · **Status:** open\n',
    );
    expect(red.join(' · ')).toMatch(/F-01 — written as a list item/);
  });

  it('скелет и пример report-shape.md набора проходят стража (документ и страж — одна форма)', () => {
    const md = readFileSync(
      join(KIT, 'skills', 'deep-review', 'references', 'report-shape.md'),
      'utf8',
    );
    const skel = /^```markdown\n([\s\S]*?)^```$/m.exec(md)?.[1] ?? '';
    const ex = /<example>\n```markdown\n([\s\S]*?)\n```\n<\/example>/.exec(md)?.[1] ?? '';
    let text = `${skel}\n## What was checked\n\n- ✗ "x" — gone: \`a.go:1\`\n\n## Findings\n\n${ex}\n`;
    const sc = report.scoreLines(report.parseReport(text));
    text = text.replace(/^\*\*Summary:\*\*.*$/m, sc.itog).replace(/^\*\*Score:\*\*.*$/m, sc.score);
    expect(ex).toContain('- F-14 🟢');
    expect(report.writeProblems(text)).toEqual([]);
  });
});

describe('review-report набора: раунды и оценка покрытия (g8 P6)', () => {
  const sp = (ledger: string, coverage: string): string =>
    report.shapeProblems(doc(ledger, coverage)).join(' · ');
  const BARE_COVER = '**Coverage:** app fully · lib fully · radius 10/10';

  it('голое запланированное «rounds N» отклоняется, «rounds k of N» — нет', () => {
    expect(sp('**Ledger:** 86/86 files · lanes 2 · rounds 2', COVER)).toContain('rounds k of N');
    expect(sp(LEDGER, COVER)).not.toContain('rounds');
  });

  it('две полосы без found / N̂ и без «coverage unknown» отклоняются', () => {
    expect(sp(LEDGER, BARE_COVER)).toContain('2 lanes owe a coverage estimate');
    expect(sp(LEDGER, `${BARE_COVER} · lanes 2 — coverage unknown, low (m = 1)`)).not.toContain(
      'estimate',
    );
    expect(
      sp('**Ledger:** 9/9 files · lanes 4 · rounds 3 of 3', `${BARE_COVER} · found 31, N̂ ≈ 52`),
    ).not.toContain('owe a coverage estimate');
    expect(sp('**Ledger:** 12/12 files · lanes 1 · rounds 1 of 1', BARE_COVER)).not.toContain(
      'estimate',
    );
  });

  it('прошло раундов меньше плана — пробел покрытия; больше плана — нет', () => {
    expect(
      report.parseReport(doc('**Ledger:** 86/86 files · lanes 2 · rounds 1 of 2')).coverageGap,
    ).toBe(true);
    expect(
      report.parseReport(doc('**Ledger:** 86/86 files · lanes 2 · rounds 3 of 2')).coverageGap,
    ).toBe(false);
  });
});
