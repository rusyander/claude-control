// review-merge: the lane union, the prover briefs and the report assembly of deep-review. What is pinned:
// candidates read in both shapes (and never from ledger rows or `clean —` cells), the union rule (same
// file+line, or ±3 lines with Jaccard ≥ 0.3), agreement never raising a severity, nothing dropped, briefs
// carrying the two guard literals under 8 KB, every 🟢 in the nit brief, and an assembled report that the
// report gate itself (hooks/lib/review-report.mjs writeProblems) passes — and refuses when a 🟡 has no proof.
// Run: node review-merge.selftest.mjs (REVIEW_MERGE_TOOL = the tool under test; default the built-in kit)
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const KIT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../../../assets/kit/agentdeck-kit',
);
const TOOL = process.env.REVIEW_MERGE_TOOL || path.join(KIT, 'tools', 'review-merge.mjs');
const PLAN_TOOL = process.env.REVIEW_PLAN_TOOL || path.join(KIT, 'tools', 'review-plan.mjs');
const M = await import(pathToFileURL(TOOL).href);
const { writeProblems } = await import(
  pathToFileURL(path.join(KIT, 'hooks', 'lib', 'review-report.mjs')).href
);

let pass = 0;
const fails = [];
const check = (name, ok, detail = '') => {
  if (ok) pass++;
  else fails.push(`${name}${detail ? ': ' + detail : ''}`);
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${name}${ok || !detail ? '' : ' — ' + detail}`);
};
const root = mkdtempSync(path.join(os.tmpdir(), 'review-merge-'));
process.on('exit', () => rmSync(root, { recursive: true, force: true }));
const run = (...a) =>
  spawnSync(process.execPath, [TOOL, ...a], {
    encoding: 'utf8',
    env: { ...process.env, REVIEW_PLAN_TOOL: PLAN_TOOL },
  });

// ---- parsing -------------------------------------------------------------------------------------------
{
  const text = [
    '# Lane A r1 — c001',
    '## Ledger',
    '| svc/a/x.ts | read · swept — minor · high · not a candidate |',
    '## Candidates',
    '- CA1 · svc/a/x.ts:10-12 · token check skipped on retry · 🟡 🔵 · high · probe: retry with stale token',
    '- A-02 · y.ts:40 the label stays after reset · stale label · nit · mid · click reset',
    '- clean — svc/a/x.ts:30 · guard holds · nit · high · read',
    '- C9 z.go · untested error branch · test gap · high · planned mutant drops the if',
    '- **R3-1** · Timeout knobs have no ceiling.',
    '  - Site: svc/b/z.go:174',
    '  - Severity guess: major (functional).',
    '  - Confidence: medium.',
    '## Sweep verdicts',
    '- A-99 · svc/a/x.ts:5 · outside the section · minor · high · read',
    '# Lane B r2 — c001',
    '## Candidates',
    '- C-B1 · svc/a/x.ts:11 · retry path reuses the token · minor · high · unit test',
  ].join('\n');
  const { cands } = M.parseLane(text, 'lane-A.md');
  const by = (id) => cands.find((c) => c.id === id);
  check(
    'new shape: severity 🟡, 🔵 kept, confidence, site',
    by('CA1')?.sev === '🟡' &&
      by('CA1').sec &&
      by('CA1').conf === 'high' &&
      by('CA1').locs[0]?.from === 10 &&
      by('CA1').locs[0]?.to === 12,
    JSON.stringify(by('CA1')),
  );
  check(
    'legacy shape: `nit` → 🟢, site description kept as thesis',
    by('A-02')?.sev === '🟢' && /label stays/.test(by('A-02').thesis),
    JSON.stringify(by('A-02')),
  );
  check('ledger row is no candidate', !cands.some((c) => /not a candidate/.test(c.raw)));
  check('`clean — file:line` cell is no candidate', !cands.some((c) => /guard holds/.test(c.raw)));
  check('legacy line outside a Candidates section is ignored', !by('A-99'));
  check(
    'a bare confidence word is no severity: `· test gap · high ·` → ❓, never 🔴',
    by('C9')?.sev === '❓' && by('C9').conf === 'high',
    JSON.stringify(by('C9')),
  );
  check(
    'multi-line labelled candidate: Site/Severity/Confidence read',
    by('R3-1')?.sev === '🟡' &&
      by('R3-1').conf === 'mid' &&
      by('R3-1').locs[0]?.file === 'svc/b/z.go',
    JSON.stringify(by('R3-1')),
  );
  check(
    '`# Lane B r2` header switches lane and round',
    by('C-B1')?.lane === 'B' && by('C-B1').round === 2,
    JSON.stringify(by('C-B1')),
  );
  check('exactly the five candidates', cands.length === 5, cands.map((c) => c.id).join(','));
}
// Site with a parenthetical + bare emoji severity (measured on a bench run: both fell to the by-eye list).
{
  const text = [
    '## Candidates',
    '- CA6 · docs/uz/a.mdx:63 (and :194 :339) · "longer than 64" while the code rejects exactly 64 · 🟢 · mid · folds into CA2',
    '- CA9 · docs/en/a.mdx:95 (+6 siblings, ru same lines) · equal dates said to fail · 🟢 🔵 · mid · request start=end → 200',
    '- CX1 · y.go · no line · plain prose · 🟢 · low · read',
  ].join('\n');
  const { cands, unparsed } = M.parseLane(text, 'lane-A-r3.md');
  const by = (id) => cands.find((c) => c.id === id);
  check(
    'site parenthetical: new shape parsed, line kept, parenthetical kept in the mechanism',
    by('CA6')?.shape === 'new' &&
      by('CA6').sev === '🟢' &&
      by('CA6').locs[0]?.from === 63 &&
      /and :194 :339/.test(by('CA6').mechanism),
    JSON.stringify(by('CA6')),
  );
  check(
    'site parenthetical + `🟢 🔵`: severity and security flag read',
    by('CA9')?.sev === '🟢' && by('CA9').sec && by('CA9').locs[0]?.from === 95,
    JSON.stringify(by('CA9')),
  );
  check(
    'legacy field `· 🟢 ·` alone reads as a severity',
    by('CX1')?.sev === '🟢' && by('CX1').shape === 'legacy',
    JSON.stringify(by('CX1')),
  );
  check('nothing left for the by-eye list', unparsed.length === 0, JSON.stringify(unparsed));
  // Places in the parenthetical place the candidate too (bench run: a docs drift named beside a code site
  // clustered with nothing at the docs line): a bare `:N` is a line of the site's file, a path:line its own.
  const locs = (id) =>
    by(id)
      ?.locs.map((l) => `${l.file}:${l.from}`)
      .join(' ');
  check(
    'site parenthetical: bare :N lines become places of the site file',
    locs('CA6') === 'docs/uz/a.mdx:63 docs/uz/a.mdx:194 docs/uz/a.mdx:339',
    locs('CA6'),
  );
  check(
    'site parenthetical without a line adds no place',
    locs('CA9') === 'docs/en/a.mdx:95',
    locs('CA9'),
  );
  const two = M.parseLane(
    [
      '## Candidates',
      '- CA2 · svc/x.go:711 (also docs/ru/a.mdx:537 uz/a.mdx:557) · tz limit 128 in the docs tables, 64 in the validator · 🟡 · high · grep',
      '- CB1 · docs/uz/a.mdx:557 · docs tables say tz limit 128, the validator 64 · 🟡 · high · read',
    ].join('\n'),
    'lane-A-r3.md',
  ).cands;
  check(
    'site parenthetical: path:line places, suffix paths kept',
    two[0]?.locs.map((l) => `${l.file}:${l.from}`).join(' ') ===
      'svc/x.go:711 docs/ru/a.mdx:537 uz/a.mdx:557',
    JSON.stringify(two[0]?.locs),
  );
  const cl = M.cluster(two.map((c) => ({ ...c, lane: c.id[1] })));
  check(
    'a candidate at a parenthetical place clusters with it (same defect, other lane)',
    cl.length === 1 && cl[0].members.length === 2,
    JSON.stringify(cl.map((c) => c.members.map((m) => m.id))),
  );
}

// Heading-block shape (a lane that wrote report-style F-blocks): site from `Where`, proof from `Evidence`.
{
  const { cands } = M.parseLane(
    [
      '## Findings',
      '### F7 🟡 token reused after refresh',
      '',
      '- **Where:** `svc/a/x.ts:10`',
      '- **Axis:** correctness',
      '- **Evidence (L1 — run):** red at base, green at head',
      '- **Status:** open',
    ].join('\n'),
    'lane-A.md',
  );
  const f7 = cands.find((c) => c.id === 'F7');
  check(
    'heading block: Where gives the site, Evidence the proof',
    f7?.shape === 'block' &&
      f7.locs[0]?.file === 'svc/a/x.ts' &&
      f7.locs[0]?.from === 10 &&
      /red at base/.test(f7.proof),
    JSON.stringify(f7),
  );
}

// ---- clustering ----------------------------------------------------------------------------------------
const cand = (id, file, from, thesis, sev = '🟡', lane = 'A') => ({
  lane,
  round: 1,
  id,
  sev,
  sec: false,
  conf: 'high',
  thesis,
  mechanism: '',
  proof: `prove ${id}`,
  locs: [{ file, from, to: from }],
  src: `lane-${lane}.md:1`,
});
{
  const cs = [
    cand('a1', 'svc/x.ts', 10, 'retry reuses the expired token after refresh', '🟢', 'A'),
    cand('b1', 'svc/x.ts', 12, 'expired token reused by retry after refresh', '🟡', 'B'),
    cand('a2', 'svc/x.ts', 40, 'label stays after reset', '🟢', 'A'),
    cand('b2', 'svc/x.ts', 40, 'completely different: pagination total wrong', '🟢', 'B'),
    cand('a3', 'svc/x.ts', 60, 'cache key misses tenant id', '🟡', 'A'),
    cand('b3', 'svc/x.ts', 62, 'button colour token hard-coded', '🟡', 'B'),
    cand('a4', 'svc/x.ts', 80, 'cache key misses tenant id', '🟡', 'A'),
    cand('b4', 'svc/x.ts', 85, 'cache key misses tenant id', '🟡', 'B'),
  ];
  const cl = M.cluster(cs);
  const of = (id) => cl.find((c) => c.members.some((m) => m.id === id));
  check('±3 lines + Jaccard ≥ 0.3 → one cluster', of('a1') === of('b1'));
  check('same file + same line → one cluster even with another mechanism', of('a2') === of('b2'));
  check('±3 lines, unrelated mechanism → apart', of('a3') !== of('b3'));
  check('same mechanism 5 lines apart → apart', of('a4') !== of('b4'));
  check('cluster severity = max of its members (🟢+🟡 → 🟡)', of('a1').sev === '🟡');
  check('agreement never raises: two 🟢 lanes stay 🟢', of('a2').sev === '🟢');
  check(
    'nothing dropped: members sum to the input',
    cl.reduce((n, c) => n + c.members.length, 0) === cs.length,
  );
  // One defect worded apart by two lanes (jaccard < 0.3) cites the same inputs; a neighbour defect in the
  // same function shares only bare identifiers and must stay apart.
  const pcs = [
    cand(
      'pa',
      'scripts/s.mjs',
      1016,
      '`parallel` takes the first non-dash word as its command, so `-j 4`, `--jobs 4`, `-S host` become the command; `readsStdin` too',
      '🟡',
      'A',
    ),
    cand(
      'pb',
      'scripts/s.mjs',
      1019,
      '`commandAt` swallows a valued option (`-j 4`, `--jobs 4`, `-S host`) and the `:::` args are lost; `readsStdin` refuses',
      '🟡',
      'B',
    ),
    cand(
      'pc',
      'scripts/s.mjs',
      1018,
      '`readsStdin` covers sh-family and `parallel` but not cmd or pwsh executors',
      '🟡',
      'A',
    ),
  ];
  const pl = M.cluster(pcs);
  const pof = (id) => pl.find((c) => c.members.some((m) => m.id === id));
  const plShape = JSON.stringify(pl.map((c) => c.members.map((m) => m.id)));
  check(
    'near + ≥2 shared input spans → one cluster despite low jaccard',
    pof('pa') === pof('pb'),
    plShape,
  );
  check('near + shared bare identifiers only → apart', pof('pc') !== pof('pa'), plShape);
  check(
    'codeSpans keeps inputs, drops bare identifiers',
    [...M.codeSpans('`readsStdin` `parallel` `-j 4` `:::`')].join('|') === '-j 4|:::',
  );
  check(
    'ids M01… in severity order 🔴 🟡 ❓ 🟢',
    cl.map((c) => c.sev).join('') ===
      [...cl]
        .sort(
          (x, y) =>
            ['🔴', '🟡', '❓', '🟢'].indexOf(x.sev) - ['🔴', '🟡', '❓', '🟢'].indexOf(y.sev),
        )
        .map((c) => c.sev)
        .join('') && cl[0].id === 'M01',
  );
  const r = M.resolver([
    'inst/src/pages/A/index.tsx',
    'inst/src/pages/B/index.tsx',
    'inst/src/x/RunHistory/index.tsx',
  ]);
  check(
    'partial path → the one plan file ending with it',
    r('RunHistory/index.tsx') === 'inst/src/x/RunHistory/index.tsx',
  );
  check('ambiguous partial path stays as written', r('index.tsx') === 'index.tsx');
  const many = Array.from({ length: 19 }, (_, i) => ({
    ...cand(`g${i}`, `svc/${i < 10 ? 'a' : 'b'}/f${i}.ts`, 1, `t${i}`),
    sev: i % 5 === 0 ? '🟢' : '🟡',
  }));
  const groups = M.proverGroups(M.cluster(many), 4);
  const flat = groups.flat();
  check(
    'prover groups ≤ max, cover every non-🟢 once, hold no 🟢',
    groups.every((g) => g.length <= 4) &&
      flat.length === many.filter((c) => c.sev !== '🟢').length &&
      new Set(flat.map((c) => c.id)).size === flat.length &&
      !flat.some((c) => c.sev === '🟢'),
    groups.map((g) => g.length).join(','),
  );
  const seven = Array.from({ length: 7 }, (_, i) => cand(`s${i}`, `svc/s${i}/f.ts`, 1, `u${i}`));
  const dflt = M.proverGroups(M.cluster(seven));
  check(
    'default prover group size is 6: 7 clusters → 2 groups',
    dflt.length === 2 && Math.max(...dflt.map((g) => g.length)) <= 6,
    dflt.map((g) => g.length).join(','),
  );
}

// ---- merge + assemble on a fixture review dir ----------------------------------------------------------
const dir = path.join(root, 'review-t');
mkdirSync(path.join(dir, 'plan'), { recursive: true });
const planFile = path.join(dir, 'plan', 'plan.json');
const files = ['svc/a/x.ts', 'svc/a/y.ts', 'svc/b/z.go'];
writeFileSync(
  planFile,
  JSON.stringify({
    repo: root,
    base: 'a'.repeat(40),
    head: 'b'.repeat(40),
    headSha: 'b'.repeat(40),
    files,
    chunks: [{ id: 'c001', items: files.map((f) => ({ path: f })) }],
    lanes: [
      { id: 'A', chunks: ['c001'], rounds: [['c001']] },
      { id: 'B', chunks: ['c001'], rounds: [['c001']] },
    ],
    rounds: 1,
    scratch: { dir: path.join(root, 'clone') },
    slug: 't',
    scope: 'test MR',
    risk: { tier: 'T2', markers: ['access and ownership'] },
  }),
);
const ledger = files.map((f) => `| ${f} | read · swept |`).join('\n');
writeFileSync(
  path.join(dir, 'lane-A.md'),
  [
    '# Lane A r1 — c001',
    '## Ledger',
    ledger,
    '## Candidates',
    '- CA1 · x.ts:10 · retry reuses the expired token after refresh · 🟢 · high · probe: retry with a stale token',
    '- CA2 · svc/b/z.go:50 · error swallowed, handler answers 200 · 🔴 · mid · go test -run TestZ',
    '- CA3 · svc/a/y.ts:7 · label typo in the header · 🟢 · high · read',
    '- CA4 · svc/a/y.ts:90 · empty list renders a spinner forever · 🟡 · mid · emptyRoute',
  ].join('\n'),
);
writeFileSync(
  path.join(dir, 'lane-B.md'),
  [
    '# Lane B r1 — c001',
    '## Ledger',
    ledger,
    '## Candidates',
    '- CB1 · svc/a/x.ts:11 · expired token reused by retry after refresh · 🟡 · high · unit test with a fake clock',
    '- CB2 · svc/a/y.ts:7 · header text uses a hyphen as a dash · 🟢 · high · read',
  ].join('\n'),
);
writeFileSync(
  path.join(dir, 'lane-A-r1.prompt.md'),
  '- CA9 · svc/a/x.ts:1 · prompt files are never read · 🔴 · high · none',
);

const mr = run('merge', '--dir', dir);
check('merge exits 0', mr.status === 0, mr.stderr);
check(
  'merge prints raw → clusters',
  /raw 6 candidates .* → 4 clusters/.test(mr.stdout),
  mr.stdout.split('\n')[0],
);
const merged = JSON.parse(readFileSync(path.join(dir, 'merged.json'), 'utf8'));
const sevOf = (id) => merged.clusters.find((c) => c.id === id)?.sev;
check(
  'merged.json: 🔴 first, cross-lane token cluster is 🟡 (max of 🟢+🟡)',
  sevOf('M01') === '🔴' &&
    merged.clusters.find((c) => c.members.some((m) => m.id === 'CB1'))?.sev === '🟡',
);
check(
  'same-line pair (y.ts:7) is one cluster with both lanes',
  merged.clusters.some((c) => c.lanes.join() === 'A,B' && c.site?.from === 7),
);
check(
  'a *.prompt.md lane file is not read',
  !merged.clusters.some((c) => c.members.some((m) => m.id === 'CA9')),
);
check(
  'merged.md written, names every member',
  (() => {
    const md = readFileSync(path.join(dir, 'merged.md'), 'utf8');
    return ['CA1', 'CA2', 'CA3', 'CA4', 'CB1', 'CB2'].every((id) => md.includes(id));
  })(),
);
const briefs = readdirSync(dir).filter((f) => /^prove-.*\.prompt\.md$/.test(f));
check(
  'one prover brief + one nit brief',
  briefs.sort().join() === 'prove-1.prompt.md,prove-nits.prompt.md',
  briefs.join(),
);
{
  // The CLI's own default (no --max-per-prover): 7 unrelated 🟡 clusters → two prover briefs, not one.
  const d7 = path.join(root, 'review-7');
  mkdirSync(d7, { recursive: true });
  const words = ['cache', 'quota', 'locale', 'cursor', 'webhook', 'backoff', 'tenant'];
  writeFileSync(
    path.join(d7, 'lane-A.md'),
    [
      '# Lane A r1 — c001',
      '## Ledger',
      ledger,
      '## Candidates',
      ...words.map(
        (w, i) =>
          `- CA${i + 1} · ${files[i % 3]}:${100 + i * 300} · ${w} ${w}-handling diverges in branch ${i} · 🟡 · mid · probe ${w}`,
      ),
    ].join('\n'),
  );
  const m7 = run('merge', '--dir', d7, '--plan', planFile);
  const b7 = readdirSync(d7).filter((f) => /^prove-\d+\.prompt\.md$/.test(f));
  check(
    'CLI default --max-per-prover 6: 7 unrelated 🟡 clusters → 2 prover briefs',
    m7.status === 0 && b7.length === 2,
    `${b7.join()} ${m7.stderr}`,
  );
}
for (const b of briefs) {
  const t = readFileSync(path.join(dir, b), 'utf8');
  const lines = t.split('\n');
  check(
    `${b}: guard literals on their own lines at the top`,
    lines[0] === '[return-format]' && lines[1] === '[no-subagents]',
  );
  check(`${b}: ≤ 8 KB`, Buffer.byteLength(t) <= 8192, String(Buffer.byteLength(t)));
  check(
    `${b}: shas and scratch clone named`,
    t.includes('a'.repeat(40)) &&
      t.includes('b'.repeat(40)) &&
      t.includes(path.join(root, 'clone')),
  );
}
const p1 = readFileSync(path.join(dir, 'prove-1.prompt.md'), 'utf8');
const pn = readFileSync(path.join(dir, 'prove-nits.prompt.md'), 'utf8');
check(
  'prover brief: ladder, kill rule, F-block fields, ✗ line',
  [
    'L0',
    'L1',
    'L2',
    'Kill rule',
    '**Where:**',
    '**Axis:**',
    '**Evidence',
    '**Status:** open',
    '✗ Mxx — refuted:',
  ].every((s) => p1.includes(s)),
);
check('prover brief carries the probe-economy section', p1.includes('## Probe economy'));
check(
  'prover brief holds no 🟢 cluster, nit brief holds every 🟢',
  merged.clusters
    .filter((c) => c.sev === '🟢')
    .every((c) => pn.includes(c.id) && !p1.includes(`### ${c.id} `)) &&
    merged.clusters.filter((c) => c.sev !== '🟢').every((c) => p1.includes(`### ${c.id} `)),
);
check(
  'spawn stubs carry the verify tag and the brief path',
  /description: deep-review verify prove-1\nYour full brief is .*prove-1\.prompt\.md — Read it first, in one Read\.\n\[return-format\]\n\[no-subagents\]/.test(
    mr.stdout,
  ),
);

const fill = path.join(root, 'fill.md');
writeFileSync(
  fill,
  [
    '**Base:** a · **reviewed head:** b · **current head:** b',
    '**Radius:** consumers 2 · entry points 1 · over the cap 0',
    '**Coverage:** svc fully; radius 2/2; lanes 2 — coverage unknown',
    '**Passes:** promises — x · config — n/a · parse — n/a · registries — n/a · deviance — n/a · claims — x · history — x · attacker — x',
    '**Acceptance:** 2 criteria — met 2',
    '**Classes:** siblings — x · parity — x · hang — n/a · before gate — n/a · environment — n/a · contract — n/a',
    '**Verified:** test',
    '**Live:** not run — test',
    '**Taken on trust:** none',
  ].join('\n'),
);
const ids = Object.fromEntries(
  merged.clusters.map((c) => [
    c.members
      .map((m) => m.id)
      .sort()
      .join('+'),
    c.id,
  ]),
);
const red = ids.CA2;
const tok = ids['CA1+CB1'];
const spin = ids.CA4;
const nit = ids['CA3+CB2'];
const block = (id, sev, proof = true) =>
  [
    `### ${id} ${sev} Thesis ${id}`,
    '',
    '- **Where:** `svc/a/x.ts:10`',
    '- **Axis:** correctness',
    ...(proof ? ['- **Evidence (L1 — run):** red at base, green at head'] : []),
    '- **Status:** open',
    '',
  ].join('\n');
// The 🔴 is killed, the token cluster survives with a second thesis, the spinner is left unanswered (→ ❓).
writeFileSync(
  path.join(dir, 'prove-1.out.md'),
  [
    `✗ ${red} — refuted: \`svc/b/z.go:52\` — error mapped to 400`,
    block(tok, '🟡'),
    block(`${tok}.2`, '🟡'),
    `See ${tok}.`,
  ].join('\n'),
);
writeFileSync(
  path.join(dir, 'prove-nits.out.md'),
  `- ${nit} 🟢 Hyphen used as a dash — **Where:** \`svc/a/y.ts:7\` · **Axis:** style · **Status:** open\n`,
);
const out = path.join(root, 'repo', '.agent', 'reviews', 't.agent.md');
const as = run('assemble', '--dir', dir, '--plan', planFile, '--out', out, '--fill', fill);
check(
  'assemble exits 0 with gate pass',
  as.status === 0 && /gate: pass/.test(as.stdout),
  as.stdout + as.stderr,
);
const rep = existsSync(out) ? readFileSync(out, 'utf8') : '';
check(
  'the report gate itself passes the file (writeProblems → [])',
  rep && writeProblems(rep).length === 0,
  JSON.stringify(rep ? writeProblems(rep) : 'no file'),
);
check(
  'findings renumbered F-01… in severity order (🟡 🟡 ❓ then 🟢)',
  /### F-01 🟡[\s\S]*### F-02 🟡[\s\S]*### F-03 ❓[\s\S]*- F-04 🟢/.test(rep),
  rep
    .split('\n')
    .filter((l) => /F-\d/.test(l))
    .join(' | '),
);
check(
  'kill written as a `- ✗` line under «What was checked»',
  /## What was checked\n\n- ✗ M\d+ `svc\/b\/z\.go:50`.*refuted: `svc\/b\/z\.go:52`/.test(rep),
);
check(
  'unanswered cluster kept as ❓, warned',
  /### F-03 ❓/.test(rep) && new RegExp(`warn: ${spin} `).test(as.stdout),
);
check(
  'cross-reference Mxx renamed to its F-id',
  !new RegExp(`\\b${tok}\\b`).test(rep.split('## Findings')[1] ?? ''),
);
check(
  'Summary / Score computed (raised = 4 findings + 1 kill)',
  /\*\*Summary:\*\* 🔴 0 · 🟡 2 · 🟢 1 · ❓ 1/.test(rep) && /raised 5 /.test(rep),
  rep.match(/\*\*(Summary|Score):.*$/gm)?.join(' | '),
);
check('Dropped filled from the kills', /\*\*Dropped:\*\* 1 of 4 candidates refuted/.test(rep));
check(
  'fill sections and lines land in the report, no blank left',
  rep.includes('**Radius:** consumers 2') && !rep.includes('⟨fill'),
);

// Red: a 🟡 without Evidence — the gate refuses, the real path stays untouched, a draft is written.
writeFileSync(
  path.join(dir, 'prove-1.out.md'),
  [`✗ ${red} — refuted: \`svc/b/z.go:52\` — mapped`, block(tok, '🟡', false)].join('\n'),
);
const out2 = path.join(root, 'repo2', '.agent', 'reviews', 't.agent.md');
const bad = run('assemble', '--dir', dir, '--plan', planFile, '--out', out2, '--fill', fill);
check(
  'a 🟡 without proof: exit 1, gate REFUSED named',
  bad.status === 1 && /gate: REFUSED/.test(bad.stdout) && /Evidence/.test(bad.stdout),
  bad.stdout,
);
check(
  'refused report never lands at the guarded path; draft beside it',
  !existsSync(out2) && existsSync(out2.replace(/\.agent\.md$/, '.draft.md')),
);
// Red: no fill — the skeleton blanks stay and the gate names them.
const bare = run(
  'assemble',
  '--dir',
  dir,
  '--plan',
  planFile,
  '--out',
  path.join(root, 'repo3', '.agent', 'reviews', 't.agent.md'),
);
check(
  'without --fill the skeleton blanks are refused',
  bare.status === 1 && /skeleton blank/.test(bare.stdout),
  bare.stdout,
);

// «Passes» / «Classes» composed from the lanes' `## Passes` when the fill leaves them out.
const pm = M.parsePasses(
  '# Lane A r1\n## Candidates\n- promises: not a pass row\n## Passes\n- promises: `rg retry` 3 → CA1\n- **config**: n/a — no new knob\n- promises: second answer loses\n## Tail\n- parse: after the section',
);
check(
  'parsePasses: rows of `## Passes` only, bold keys read, first answer wins',
  pm.get('promises') === '`rg retry` 3 → CA1' &&
    pm.get('config') === 'n/a — no new knob' &&
    !pm.has('parse') &&
    pm.size === 2,
  JSON.stringify([...pm]),
);
check(
  'laneLabel: header first, then the file name',
  M.laneLabel('# Lane B r2 — c001', 'lane-A.md') === 'B r2' &&
    M.laneLabel('no header', 'lane-A-r3.md') === 'A r3',
);
const { PASS_HINTS } = await import(pathToFileURL(PLAN_TOOL).href);
check(
  'pass keys = review-plan PASS_HINTS keys, same order (the lane prompt asks exactly these)',
  JSON.stringify([...M.PASS_KEYS, ...M.CLASS_KEYS].map(([en]) => en)) ===
    JSON.stringify(PASS_HINTS.map((h) => h.split(' (')[0])),
);
const allKeys = (v) => [...M.PASS_KEYS, ...M.CLASS_KEYS].map(([en]) => `- ${en}: ${v}`).join('\n');
const pl = M.passLines(
  [
    { label: 'A r1', text: `## Passes\n${allKeys('n/a — none found')}\n` },
    {
      label: 'B r1',
      text: '## Passes\n- promises: retry walked, CB1 · timeout exit\n- siblings: `rg token` 2\n',
    },
  ],
  (label, s) => s.replace('CB1', label === 'B r1' ? 'F-01' : 'CB1'),
);
check(
  'passLines: a real answer beats n/a, labelled, C-id renamed, « · » kept off the line',
  pl.passes.startsWith(
    '**Passes:** promises — retry walked, F-01; timeout exit (B r1) · config — n/a — none found (A r1)',
  ) && pl.classes.includes('siblings — `rg token` 2 (B r1)'),
  pl.passes,
);
check(
  'passLines: no lane answered any key → null (the skeleton blank stays)',
  M.passLines([{ label: 'A r1', text: '## Candidates\n' }]).passes === null,
);
check(
  'passLines: a key no lane answered gets a blank the hook refuses',
  M.passLines([{ label: 'A r1', text: '## Passes\n- promises: x\n' }]).passes.includes(
    'config — ⟨fill:',
  ),
);

writeFileSync(
  path.join(dir, 'prove-1.out.md'),
  [
    `✗ ${red} — refuted: \`svc/b/z.go:52\` — error mapped to 400`,
    block(tok, '🟡'),
    block(`${tok}.2`, '🟡'),
  ].join('\n'),
);
const laneA = readFileSync(path.join(dir, 'lane-A.md'), 'utf8');
writeFileSync(
  path.join(dir, 'lane-A.md'),
  `${laneA}\n## Passes\n${allKeys('n/a — no trigger in c001')}\n`,
);
writeFileSync(
  path.join(dir, 'lane-B.md'),
  `${readFileSync(path.join(dir, 'lane-B.md'), 'utf8')}\n## Passes\n- promises: retry × expired token walked → CB1\n- contract: \`openapi.yaml:12\` vs validator\n`,
);
const fillNoPasses = path.join(root, 'fill-np.md');
writeFileSync(
  fillNoPasses,
  readFileSync(fill, 'utf8')
    .split('\n')
    .filter((l) => !/^\*\*(Passes|Classes):/.test(l))
    .join('\n'),
);
const out4 = path.join(root, 'repo4', '.agent', 'reviews', 't.agent.md');
const ap = run('assemble', '--dir', dir, '--plan', planFile, '--out', out4, '--fill', fillNoPasses);
const rep4 = existsSync(out4) ? readFileSync(out4, 'utf8') : '';
const tokF = rep4.match(new RegExp(`### (F-\\d+) 🟡 Thesis`))?.[1];
check(
  'assemble: Passes/Classes composed from lanes, gate passes',
  ap.status === 0 &&
    /^\*\*Passes:\*\* promises — retry × expired token walked → F-0\d \(B r1\) · config — n\/a — no trigger in c001 \(A r1\)/m.test(
      rep4,
    ) &&
    /^\*\*Classes:\*\* siblings — n\/a — no trigger in c001 \(A r1\).* · contract — `openapi\.yaml:12` vs validator \(B r1\)$/m.test(
      rep4,
    ),
  ap.stdout + (rep4.match(/^\*\*(Passes|Classes):.*$/gm) ?? []).join('\n'),
);
check(
  'assemble: a lane key differing from its report name maps (before-gate → «before gate»)',
  /^\*\*Classes:\*\*.* · before gate — n\/a — no trigger in c001 \(A r1\) · /m.test(rep4),
  rep4.match(/^\*\*Classes:.*$/m)?.[0],
);
check(
  'assemble: a lane C-id in a pass answer becomes the F-id of its cluster',
  tokF && rep4.includes(`walked → ${tokF} (B r1)`),
  `${tokF} ${rep4.match(/^\*\*Passes:.*$/m)?.[0]}`,
);
check(
  'assemble: a fill line still wins over the composed one',
  readFileSync(out, 'utf8').includes('**Passes:** promises — x · config — n/a'),
);

console.log(`\n${pass} passed, ${fails.length} failed`);
if (fails.length) {
  for (const f of fails) console.log(`  - ${f}`);
  process.exit(1);
}
