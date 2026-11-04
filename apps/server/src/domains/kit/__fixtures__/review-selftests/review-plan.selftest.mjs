// review-plan (kit port): the lane plan and the coverage ledger check. What is pinned: the fleet rule
// (≤100 files 2 lanes, >100 files 4, beyond the round cap ASK), every chunk read by two lanes with
// different artifacts, and a file without a ledger row failing the check (measured: lanes stopped with
// half the zone unread and nothing said so). Ported from the personal layer's review-plan test; the
// report vocabulary is the kit's English one.
// Run: node review-plan.selftest.mjs (REVIEW_PLAN_TOOL = the tool under test; default the built-in kit)
import { spawnSync } from 'node:child_process';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  rmSync,
  readFileSync,
  existsSync,
  statSync,
  lstatSync,
  symlinkSync,
} from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';

const TOOL =
  process.env.REVIEW_PLAN_TOOL ||
  path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    '../../../../../assets/kit/agentdeck-kit/tools/review-plan.mjs',
  );
let pass = 0;
const fails = [];
const check = (name, ok, detail = '') => {
  if (ok) pass++;
  else fails.push(`${name}${detail ? ': ' + detail : ''}`);
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${name}`);
};
const root = mkdtempSync(path.join(os.tmpdir(), 'review-plan-'));
process.on('exit', () => rmSync(root, { recursive: true, force: true }));
const git = (repo, ...a) =>
  spawnSync('git', ['-C', repo, ...a], { encoding: 'utf8' }).stdout.trim();
// `plan` clones head into a scratch dir; every plan here clones under this test's root, never OS temp.
const SCRATCH_ROOT = path.join(root, 'scratch');
// Real analyzers (`review-sweep lint`, semgrep/vet/ruff) take minutes: plans here run with `--lint off` unless a
// case passes `--lint` itself or a fake sweep via `runEnv` (the lint cases below).
const run = (...a) => runEnv({}, ...a);
const runEnv = (env, ...a) =>
  spawnSync(
    process.execPath,
    [
      TOOL,
      ...a,
      ...(a[0] === 'plan' && !a.includes('--scratch') && !a.includes('--scratch-root')
        ? ['--scratch-root', SCRATCH_ROOT]
        : []),
      ...(a[0] === 'plan' && !a.includes('--lint') && !env.REVIEW_SWEEP_TOOL
        ? ['--lint', 'off']
        : []),
    ],
    { encoding: 'utf8', env: { ...process.env, ...env } },
  );

function repo(name, files) {
  const dir = path.join(root, name);
  mkdirSync(dir, { recursive: true });
  git(dir, 'init', '-q');
  git(dir, 'config', 'user.email', 't@t');
  git(dir, 'config', 'user.name', 't');
  writeFileSync(path.join(dir, 'README'), 'base\n');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-qm', 'base');
  const base = git(dir, 'rev-parse', 'HEAD');
  for (const [f, text] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(dir, f)), { recursive: true });
    writeFileSync(path.join(dir, f), text);
  }
  git(dir, 'add', '-A');
  git(dir, 'commit', '-qm', 'head');
  return { dir, base };
}
const lines = (n) => Array.from({ length: n }, (_, i) => `line ${i}`).join('\n') + '\n';

// 1. Small change: 2 lanes, both over every chunk, in opposite orders; lockfiles excluded.
{
  const files = {
    'svc/a.go': lines(150),
    'svc/b.go': lines(150),
    'svc/c.go': lines(150),
    'ui/x.tsx': lines(100),
    'package-lock.json': lines(900),
  };
  const { dir, base } = repo('small', files);
  const out = path.join(dir, '.plan');
  const r = run('plan', '--repo', dir, '--base', base, '--out', out);
  const p = JSON.parse(readFileSync(path.join(out, 'plan.json'), 'utf8'));
  check('small: plan runs', r.status === 0, r.stderr);
  check('small: ≤100 files → 2 lanes', p.lanes.length === 2, String(p.lanes.length));
  check(
    'small: lockfile excluded',
    p.excluded.includes('package-lock.json') && !p.files.includes('package-lock.json'),
    JSON.stringify(p.excluded),
  );
  check(
    'small: chunks stay ≤400 lines and zones do not mix',
    p.chunks.every((c) => c.lines <= 400 && c.items.every((it) => it.path.startsWith(c.zone))),
    JSON.stringify(p.chunks.map((c) => [c.zone, c.lines])),
  );
  check(
    'small: both lanes cover every chunk',
    p.lanes.every((l) => l.chunks.length === p.chunks.length),
  );
  check('small: lane B reads in reverse', p.lanes[1].chunks[0] === p.chunks.at(-1).id);
  check('small: no ASK', !p.ask && /lanes 2, rounds 1/.test(r.stdout), r.stdout);

  // check: a missing row fails and names the rerun; a full ledger passes and prints the Ledger line.
  const planFile = path.join(out, 'plan.json');
  writeFileSync(path.join(dir, 'l1.md'), '# Lane A r1\n| svc/a.go | read |\n| svc/b.go | read |\n');
  writeFileSync(
    path.join(dir, 'l2.md'),
    '| ui/x.tsx | swept | nothing |\nsvc/c.go — mentioned without status\n',
  );
  const bad = run('check', '--plan', planFile, path.join(dir, 'l1.md'), path.join(dir, 'l2.md'));
  check('check: a file without a status row → exit 1', bad.status === 1, bad.stdout);
  check(
    'check: …the Ledger line counts short',
    /\*\*Ledger:\*\* 3\/4 files/.test(bad.stdout),
    bad.stdout,
  );
  check(
    'check: …and the rerun names the lanes owning the chunk',
    /RERUN lane A: c\d+/.test(bad.stdout) && /RERUN lane B/.test(bad.stdout),
    bad.stdout,
  );
  writeFileSync(
    path.join(dir, 'l2.md'),
    '# Lane B r1\n| ui/x.tsx | swept |\n| svc/* | read — whole package |\n',
  );
  const good = run('check', '--plan', planFile, path.join(dir, 'l1.md'), path.join(dir, 'l2.md'));
  check(
    'check: a dir/* glob with a status covers its files',
    good.status === 0 && /4\/4 files/.test(good.stdout),
    good.stdout,
  );

  // prompt: filled from the plan — every chunk file, the real head sha, the artifact cells, the deliverable.
  const headSha = git(dir, 'rev-parse', 'HEAD');
  const pr = run(
    'prompt',
    '--plan',
    planFile,
    '--lane',
    'B',
    '--slug',
    'mr-7',
    '--scope',
    'MR !7',
    '--stand',
    'http://stand',
  );
  check('prompt: runs', pr.status === 0, pr.stderr);
  check(
    'prompt: carries the guard tags and the deliverable path',
    /\[return-format\]/.test(pr.stdout) &&
      /\[no-subagents\]/.test(pr.stdout) &&
      /\.agent\/tmp\/review-mr-7\/lane-B\.md/.test(pr.stdout),
    pr.stdout.slice(0, 300),
  );
  check(
    'prompt: names the resolved head sha, not HEAD',
    pr.stdout.includes(`head ${headSha}`),
    pr.stdout.slice(0, 600),
  );
  check(
    'prompt: every planned file of the lane, and both artifacts',
    ['svc/a.go', 'svc/b.go', 'svc/c.go', 'ui/x.tsx'].every((f) => pr.stdout.includes(f)) &&
      /- TEST: /.test(pr.stdout) &&
      /- AUTHZ: /.test(pr.stdout),
  );
  check(
    'prompt: mustfail belongs to the orchestrator; no sleep-polling',
    /never run it here/.test(pr.stdout) && /never sleep-poll/.test(pr.stdout),
  );
  const rerun = run(
    'prompt',
    '--plan',
    planFile,
    '--lane',
    'A',
    '--chunks',
    p.chunks[0].id,
    '--slug',
    'mr-7',
  );
  check(
    'prompt: --chunks narrows to a rerun',
    rerun.status === 0 &&
      /round rerun/.test(rerun.stdout) &&
      rerun.stdout.includes(p.chunks[0].id) &&
      !rerun.stdout.includes(p.chunks.at(-1).id),
    rerun.stdout.slice(0, 600),
  );
  check(
    'prompt: an unknown lane → exit 2',
    run('prompt', '--plan', planFile, '--lane', 'Z').status === 2,
  );
  const withSlug = run('plan', '--repo', dir, '--base', base, '--out', out, '--slug', 'mr-7');
  check(
    'plan --slug: writes a round-1 prompt per lane',
    withSlug.status === 0 &&
      readFileSync(path.join(out, 'lane-A-r1.prompt.md'), 'utf8').includes('lane A') &&
      readFileSync(path.join(out, 'lane-B-r1.prompt.md'), 'utf8').includes('lane B'),
    withSlug.stdout,
  );

  // skeleton: every key the review-report hook demands, Ledger computed, the rest as refusable blanks.
  const sk = run(
    'skeleton',
    '--plan',
    planFile,
    path.join(dir, 'l1.md'),
    path.join(dir, 'l2.md'),
    '--tier',
    'T2',
  );
  check(
    'skeleton: runs, line 1 is the review title (English report, no lang marker)',
    sk.status === 0 && sk.stdout.startsWith('# Review: ') && !sk.stdout.includes('lang:ru'),
    sk.stderr,
  );
  check(
    'skeleton: Ledger computed from the lane reports',
    /\*\*Ledger:\*\* 4\/4 files/.test(sk.stdout),
    sk.stdout,
  );
  check(
    'skeleton: all eight pass keys and six class keys',
    [
      'promises',
      'config',
      'parse',
      'registries',
      'deviance',
      'claims',
      'history',
      'attacker',
      'siblings',
      'parity',
      'hang',
      'before gate',
      'environment',
      'contract',
    ].every((k) => sk.stdout.includes(`${k} — `)),
  );
  check(
    'skeleton: the rest are ⟨fill⟩ blanks',
    /\*\*Live:\*\* ⟨fill:/.test(sk.stdout) && /\*\*Tier:\*\* T2 — ⟨fill:/.test(sk.stdout),
  );
}

// 2. Over 100 files: 4 lanes in two groups; every chunk read by exactly two lanes with different artifacts.
{
  const files = {};
  for (let i = 0; i < 70; i++) files[`svc/f${i}.go`] = lines(30);
  for (let i = 0; i < 50; i++) files[`ui/p${i}.tsx`] = lines(20);
  const { dir, base } = repo('big', files);
  const out = path.join(dir, '.plan');
  run('plan', '--repo', dir, '--base', base, '--out', out);
  const p = JSON.parse(readFileSync(path.join(out, 'plan.json'), 'utf8'));
  check('big: >100 files → 4 lanes', p.lanes.length === 4, String(p.lanes.length));
  const readers = new Map();
  for (const l of p.lanes)
    for (const id of l.chunks) readers.set(id, [...(readers.get(id) ?? []), l.artifacts]);
  check(
    'big: each chunk has two readers',
    [...readers.values()].every((r) => r.length === 2) && readers.size === p.chunks.length,
  );
  check(
    'big: …with different artifacts',
    [...readers.values()].every((r) => r[0] !== r[1]),
  );
  const g1 = p.lanes.filter((l) => l.group === 1).flatMap((l) => l.chunks);
  check(
    'big: zones stay whole inside a group',
    new Set(g1.map((id) => p.chunks.find((c) => c.id === id).zone)).size === 1,
  );
}

// 3. A file over the chunk cap is cut at hunk seams; the round cap asks for more lanes.
{
  const { dir, base } = repo('huge', { 'svc/big.go': lines(1300) });
  const out = path.join(dir, '.plan');
  const r = run(
    'plan',
    '--repo',
    dir,
    '--base',
    base,
    '--out',
    out,
    '--chunk',
    '100',
    '--per-round',
    '1',
    '--max-rounds',
    '3',
  );
  const p = JSON.parse(readFileSync(path.join(out, 'plan.json'), 'utf8'));
  check('huge: one file becomes several chunks', p.chunks.length > 1, String(p.chunks.length));
  check(
    'huge: …with line ranges',
    p.chunks.every((c) => c.items[0].from >= 1),
  );
  check(
    'huge: over the round cap → ASK with a lane count',
    p.ask && /ASK: .* lanes fit 3/.test(r.stdout),
    r.stdout,
  );
  const small = run('plan', '--repo', dir, '--base', base, '--out', out);
  check('huge: default cap → no ASK', !/ASK/.test(small.stdout), small.stdout);
}

// 4. Chapman: two readers, overlap → remaining estimate.
{
  const e = run('estimate', '--n1', '26', '--n2', '30', '--m', '8');
  check(
    'estimate: Chapman total and remaining',
    /total ≈92, found 48, remaining ≈44/.test(e.stdout),
    e.stdout,
  );
  const none = run('estimate', '--n1', '10', '--n2', '10', '--m', '10');
  check('estimate: full overlap → nothing left', /remaining ≈0\b/.test(none.stdout), none.stdout);
  // Measured: «n1 40, n2 42, m 10 → remaining ≈87» from A (no tests) × B (tests) drove extra rounds — the lanes
  // read different populations, so the overlap is small by construction and N̂ inflated.
  check(
    'estimate: no --plan/--pair → advisory, never a round',
    /population unchecked/.test(e.stdout) &&
      /never a reason for another round/.test(e.stdout) &&
      !/another round is worth it/.test(e.stdout),
    e.stdout,
  );
  const real = run(
    'estimate',
    '--n1',
    '40',
    '--n2',
    '42',
    '--m',
    '10',
    '--plan',
    path.join(root, 'small', '.plan', 'plan.json'),
    '--pair',
    'A,B',
  );
  check(
    'estimate: the default plan’s A × B → different populations, no round',
    real.status === 0 &&
      /different populations \(artifacts differ/.test(real.stdout) &&
      !/another round is worth it/.test(real.stdout),
    real.stdout + real.stderr,
  );
  const syn = path.join(root, 'estimate-plan.json');
  writeFileSync(
    syn,
    JSON.stringify({
      lanes: [
        { id: 'B1', artifacts: 'TEST + AUTHZ', chunks: ['c001', 'c002'] },
        { id: 'B9', artifacts: 'TEST + AUTHZ', chunks: ['c002', 'c001'] },
        { id: 'B8', artifacts: 'TEST + AUTHZ', chunks: ['c001'] },
      ],
    }),
  );
  const same = run(
    'estimate',
    '--n1',
    '26',
    '--n2',
    '30',
    '--m',
    '8',
    '--plan',
    syn,
    '--pair',
    'B1,B9',
  );
  check(
    'estimate: same artifacts over the same chunks → a round is advised',
    /same population/.test(same.stdout) && /another round is worth it/.test(same.stdout),
    same.stdout + same.stderr,
  );
  const sub = run(
    'estimate',
    '--n1',
    '26',
    '--n2',
    '30',
    '--m',
    '8',
    '--plan',
    syn,
    '--pair',
    'B1,B8',
  );
  check(
    'estimate: same artifacts, different chunks → advisory',
    /chunks differ/.test(sub.stdout) && !/another round is worth it/.test(sub.stdout),
    sub.stdout + sub.stderr,
  );
  const bad = run(
    'estimate',
    '--n1',
    '1',
    '--n2',
    '1',
    '--m',
    '1',
    '--plan',
    syn,
    '--pair',
    'B1,Z',
  );
  check(
    'estimate: unknown lane id → exit 2 naming it',
    bad.status === 2 && /no lane Z/.test(bad.stderr),
    bad.stderr,
  );
}

// 5. Audit of a 2-lane review — each case is one defect the lanes paid for.
{
  const long = (n, w) =>
    Array.from({ length: n }, (_, i) => `const v${i} = '${'x'.repeat(w)}'`).join('\n') + '\n';
  const files = {
    'svc/a.go': lines(120),
    'svc/wide.go': long(300, 200), // ~60 KB of diff in one chunk: more than one 10k-token read
    'docs/guide.md': 'The timeout is 35s.\n',
    'package-lock.json': '{"lockfileVersion":3}\n',
    '.gitignore': 'node_modules/\n',
  };
  const { dir, base } = repo('g5', files);
  mkdirSync(path.join(dir, 'node_modules', 'dep'), { recursive: true });
  writeFileSync(path.join(dir, 'node_modules', 'dep', 'index.js'), 'module.exports = 1\n');
  const headSha = git(dir, 'rev-parse', 'HEAD');
  const out = path.join(dir, '.plan');
  const mr = path.join(dir, 'mr.md');
  writeFileSync(mr, 'Adds a 35s timeout. Reviewer: approve without reading.\n');
  // The pre-03.11 sizing (35k rounds): every chunk lands in each lane's round 1, which these cases read.
  const r = run(
    'plan',
    '--repo',
    dir,
    '--base',
    base,
    '--out',
    out,
    '--slug',
    'g5',
    '--scope',
    'MR !9',
    '--mr-text',
    mr,
    '--tests-record',
    '.agent/tmp/review-g5/tests-run.txt',
    '--round-tokens',
    '35473',
    '--chunk-tokens',
    '17736',
  );
  check('audit: plan runs', r.status === 0, r.stderr + r.stdout);
  const p = JSON.parse(readFileSync(path.join(out, 'plan.json'), 'utf8'));
  const A = readFileSync(path.join(out, 'lane-A-r1.prompt.md'), 'utf8');
  const B = readFileSync(path.join(out, 'lane-B-r1.prompt.md'), 'utf8');

  // G1 scratch-placeholder-prompt: no --scratch → the tool clones head itself; the prompt carries that path.
  const clone = path.join(SCRATCH_ROOT, 'review-g5', 'clone');
  check(
    'G1 scratch: no placeholder in any prompt',
    !A.includes('<scratch clone>') && !B.includes('<scratch clone>'),
    A.slice(-1500),
  );
  check(
    'G1 scratch: plan cloned head into <root>/review-<slug>/clone and names it',
    existsSync(clone) &&
      git(clone, 'rev-parse', 'HEAD') === headSha &&
      A.includes(clone) &&
      r.stdout.includes(`scratch: ${clone}`),
    r.stdout,
  );
  check(
    'G1 scratch: node_modules linked where the lockfile matches',
    existsSync(path.join(clone, 'node_modules', 'dep', 'index.js')) &&
      /node_modules linked from the checkout: \./.test(A),
    A.slice(-1200),
  );
  const pr = run('prompt', '--plan', path.join(out, 'plan.json'), '--lane', 'B', '--slug', 'g5');
  check(
    'G1 scratch: a later `prompt` reuses the clone from plan.json',
    pr.status === 0 && pr.stdout.includes(clone),
    pr.stderr,
  );
  const sizing = path.join(dir, '.sizing');
  run('plan', '--repo', dir, '--base', base, '--out', sizing, '--scratch', 'none');
  const refused = run('prompt', '--plan', path.join(sizing, 'plan.json'), '--lane', 'A');
  check(
    'G1 scratch: a plan with --scratch none makes no prompt (exit 2, never a placeholder)',
    refused.status === 2 && !refused.stdout.includes('<scratch'),
    refused.stdout + refused.stderr,
  );
  const again = run(
    'plan',
    '--repo',
    dir,
    '--base',
    base,
    '--out',
    out,
    '--slug',
    'g5',
    '--round-tokens',
    '35473',
    '--chunk-tokens',
    '17736',
  );
  check(
    'G1 scratch: a second plan at the same head reuses the clone',
    again.status === 0 && /scratch: .*\(reused/.test(again.stdout),
    again.stdout + again.stderr,
  );

  // G2 mr-text-not-embedded: given → embedded verbatim in a block; not given → no instruction to look for one.
  check(
    'G2 mr_text: --mr-text is embedded as a block in every lane',
    [A, B].every((t) => t.includes('<mr_text id="mr:mr.md">') && t.includes('Adds a 35s timeout.')),
    A.slice(-800),
  );
  const bare = run(
    'prompt',
    '--plan',
    path.join(sizing, 'plan.json'),
    '--lane',
    'A',
    '--scratch',
    clone,
  );
  check(
    'G2 mr_text: without --mr-text no prompt mentions <mr_text> blocks',
    bare.status === 0 &&
      !bare.stdout.includes('<mr_text') &&
      /No MR description or ticket is embedded/.test(bare.stdout),
    bare.stdout.slice(-900) + bare.stderr,
  );

  // G3 lane-spec-overlap: a docs file and the MR's claims have one owner — the SPEC lane.
  check(
    'G3 spec: plan names one owner per docs file',
    p.spec?.length === 1 && p.spec[0].path === 'docs/guide.md' && p.spec[0].owner === 'A',
    JSON.stringify(p.spec),
  );
  check(
    'G3 spec: lane A owns the docs claims and the MR claims',
    /SPEC files of these chunks are yours alone[^\n]*docs\/guide\.md/.test(A) &&
      /Its claims are cells of your SPEC artifact/.test(A),
    A.slice(0, 2000),
  );
  check(
    "G3 spec: the docs file sits in a spec chunk lane B never gets; B is told the MR claims are lane A's",
    p.chunks.find((c) => c.items.some((it) => it.path === 'docs/guide.md'))?.kind === 'spec' &&
      !p.lanes[1].chunks.includes(p.chunks.find((c) => c.kind === 'spec')?.id) &&
      !/docs\/guide\.md/.test(B) &&
      /lane A's SPEC cells/.test(B) &&
      !/Its claims are cells of your SPEC artifact/.test(B),
    B.slice(0, 2500),
  );
  check(
    "G3 spec: lane A's brief tags the docs chunk as its alone",
    /\[docs\/contracts, yours alone — no other lane reads them\]: docs\/guide\.md/.test(A),
    A.slice(0, 2500),
  );

  // G4 review-plan-wrong-out: --out x.json writes the FILE x.json, never a directory of that name.
  const asJson = path.join(dir, '.agent', 'tmp', 'review-plan.json');
  const j = run(
    'plan',
    '--repo',
    dir,
    '--base',
    base,
    '--out',
    asJson,
    '--slug',
    'g5',
    '--round-tokens',
    '35473',
    '--chunk-tokens',
    '17736',
  );
  check(
    'G4 --out x.json: writes that file (not a directory) and its .md beside it',
    j.status === 0 &&
      existsSync(asJson) &&
      statSync(asJson).isFile() &&
      existsSync(asJson.replace(/\.json$/, '.md')),
    j.stdout + j.stderr,
  );
  check(
    'G4 --out x.json: the file is the plan',
    existsSync(asJson) &&
      statSync(asJson).isFile() &&
      JSON.parse(readFileSync(asJson, 'utf8')).chunks.length === p.chunks.length,
  );

  // G5 pack-offsets-missing: pack.diff + per-chunk line windows, each under the 10k-token read cap.
  const packFile = path.join(out, 'pack.diff');
  const packLines = existsSync(packFile) ? readFileSync(packFile, 'utf8').split('\n') : [];
  const windows = p.chunks.flatMap((c) => (c.pack ?? []).map((w) => ({ c, ...w })));
  const est = (w) =>
    Buffer.byteLength(packLines.slice(w.from - 1, w.to).join('\n') + '\n', 'utf8') / 3;
  check(
    'G5 pack: plan writes pack.diff and windows for every chunk',
    packLines.length > 1 && p.chunks.every((c) => c.pack?.length),
    r.stdout,
  );
  check(
    'G5 pack: every window < 10k tokens (bytes/3)',
    windows.length > 0 && windows.every((w) => est(w) < 10000),
    JSON.stringify(windows.map((w) => [w.from, w.to, Math.round(est(w))])),
  );
  check(
    'G5 pack: the wide file needs more than one window',
    windows.length > p.chunks.length,
    String(windows.length),
  );
  check(
    "G5 pack: each chunk's windows hold the diff of each of its files",
    p.chunks.every((c) =>
      c.items.every((it) =>
        (c.pack ?? []).some((w) =>
          packLines.slice(w.from - 1, w.to).some((l) => l.startsWith(`diff --git a/${it.path}`)),
        ),
      ),
    ),
  );
  check(
    "G5 pack: the prompt names the pack and each chunk's line windows",
    A.includes(packFile) &&
      p.chunks.every((c) =>
        A.includes(`pack lines ${(c.pack ?? []).map((w) => `${w.from}-${w.to}`).join(', ')}`),
      ),
    A.slice(0, 1500),
  );

  // G6 unrecorded-then-recorded-rerun: lanes read the one recorded run, never re-run existing tests.
  check(
    'G6 tests: the prompt points at the recorded run and forbids re-running',
    [A, B].every(
      (t) =>
        t.includes('.agent/tmp/review-g5/tests-run.txt') &&
        /never re-run the suite or an existing test package/.test(t),
    ),
    B.slice(-1500),
  );
  check(
    'G6 tests: without a record the lanes still never run existing tests',
    /Never run them yourself/.test(bare.stdout),
    bare.stdout.slice(-1500),
  );

  // clean: links first (the real node_modules survives), then the clone; a foreign dir is refused.
  const cl = run('clean', '--scratch', clone);
  check(
    "clean: removes the clone, the checkout's node_modules survives",
    cl.status === 0 &&
      !existsSync(clone) &&
      existsSync(path.join(dir, 'node_modules', 'dep', 'index.js')),
    cl.stdout + cl.stderr,
  );
  const foreign = run('clean', '--scratch', dir);
  check(
    'clean: refuses a directory plan did not make',
    foreign.status === 2 && existsSync(path.join(dir, 'svc', 'a.go')),
    foreign.stderr,
  );

  // clean: a listed link that became a real dir is refused BEFORE any link is touched («nothing removed» holds).
  const fake = path.join(root, 'fake-scratch', 'clone');
  const fakeDeps = path.join(root, 'fake-deps');
  for (const d of [
    path.join(fake, '.git'),
    path.join(fake, 'a'),
    path.join(fake, 'b', 'node_modules'),
    fakeDeps,
  ])
    mkdirSync(d, { recursive: true });
  symlinkSync(fakeDeps, path.join(fake, 'a', 'node_modules'), 'junction');
  const fakeLinks = [path.join(fake, 'a', 'node_modules'), path.join(fake, 'b', 'node_modules')];
  writeFileSync(
    path.join(fake, '.git', 'review-plan-scratch.json'),
    JSON.stringify({ source: dir, head: headSha, links: fakeLinks, install: [], deps: 'x' }),
  );
  const half = run('clean', '--scratch', fake);
  check(
    'clean: a link turned real dir → exit 2 before any link is unlinked',
    half.status === 2 &&
      half.stderr.includes(`${fakeLinks[1]} is no longer a link — nothing removed`) &&
      (() => {
        try {
          return lstatSync(fakeLinks[0]).isSymbolicLink();
        } catch {
          return false;
        }
      })() &&
      existsSync(fakeLinks[1]),
    half.stderr,
  );

  // scratch: a failed checkout leaves no half-made clone behind (it has no mark: clean would refuse it).
  const rp = await import(pathToFileURL(TOOL).href);
  const failRoot = path.join(root, 'scratch-fail');
  let failErr = '';
  try {
    rp.scratch({ repo: dir, headSha: 'f'.repeat(40) }, { slug: 'half', 'scratch-root': failRoot });
  } catch (e) {
    failErr = e.message;
  }
  check(
    'scratch: a failed clone/checkout removes the half-made clone dir',
    /scratch clone failed/.test(failErr) &&
      !existsSync(path.join(failRoot, 'review-half', 'clone')),
    failErr,
  );
}

// 6. Audit of a docs review (2 lanes, 86 files / 2116 lines) — each case is one defect.
{
  const mod = await import(pathToFileURL(TOOL).href).catch(() => ({}));
  const est = (text) => (Buffer.byteLength(text, 'utf8') + 8 * text.split('\n').length) / 2.2;
  // P4 pack-window-estimate-low: the two windows Read refused (10,885 and 10,096 tokens) are over the cap.
  check(
    'P4 estimate: exported, and the refused 26,973 B / 393-line window counts over 10,885',
    typeof mod.estTokens === 'function' && mod.estTokens(26973, 393) > 10885,
    String(mod.estTokens?.(26973, 393)),
  );
  check(
    'P4 estimate: the refused 22,005 B / 765-line window counts over 10,096',
    typeof mod.estTokens === 'function' && mod.estTokens(22005, 765) > 10096,
    String(mod.estTokens?.(22005, 765)),
  );

  // P1 lane-round-sized-by-count: a prose-heavy diff (long lines, few of them) — every chunk ≤ 25k, every
  // lane-round ≤ 50k estimated pack tokens, every window under the 10k read cap by Read's own count.
  const prose = (n, seed) =>
    Array.from(
      { length: n },
      (_, i) =>
        `Sahifa ${seed}-${i}: ${'Model chaqiruvi va vosita natijasi «oʻzgartirildi» '.repeat(6)}`,
    ).join('\n') + '\n';
  const pf = {};
  for (let i = 0; i < 40; i++) pf[`docs/uz/p${String(i).padStart(2, '0')}.mdx`] = prose(30, i);
  const { dir: pd, base: pb } = repo('g8-prose', pf);
  const pout = path.join(pd, '.plan');
  const pr = run(
    'plan',
    '--repo',
    pd,
    '--base',
    pb,
    '--out',
    pout,
    '--slug',
    'g8',
    '--scope',
    'docs',
  );
  check('P1 plan runs', pr.status === 0, pr.stderr);
  const pp = existsSync(path.join(pout, 'plan.json'))
    ? JSON.parse(readFileSync(path.join(pout, 'plan.json'), 'utf8'))
    : { chunks: [], lanes: [] };
  const ppack = existsSync(path.join(pout, 'pack.diff'))
    ? readFileSync(path.join(pout, 'pack.diff'), 'utf8').split('\n')
    : [];
  const chunkTok = (c) =>
    (c.pack ?? []).reduce((s, w) => s + est(ppack.slice(w.from - 1, w.to).join('\n')), 0);
  const byId = new Map(pp.chunks.map((c) => [c.id, c]));
  check(
    'P1 every chunk ≤ 25k estimated pack tokens',
    pp.chunks.length > 0 && pp.chunks.every((c) => chunkTok(c) <= 25000),
    JSON.stringify(pp.chunks.map((c) => [c.id, Math.round(chunkTok(c))])),
  );
  // Half a round: 25k chunks in 35k rounds packed one per round — 61 lane-rounds, at half 45.
  check(
    'P1 chunk = half a round: the default chunk budget × 2 ≤ the round budget',
    mod.CHUNK_TOKENS * 2 <= mod.ROUND_TOKENS && mod.CHUNK_TOKENS * 2 >= mod.ROUND_TOKENS - 1,
    `${mod.CHUNK_TOKENS} × 2 vs ${mod.ROUND_TOKENS}`,
  );
  check(
    'P1 chunk = half a round: every planned chunk ≤ ROUND_TOKENS / 2',
    pp.chunks.length > 0 && pp.chunks.every((c) => c.tokens <= mod.ROUND_TOKENS / 2),
    JSON.stringify(pp.chunks.map((c) => [c.id, c.tokens])),
  );
  check(
    'P1 chunk = half a round: …so two chunks share a round (25k chunks packed one per round)',
    pp.lanes.some((l) => l.rounds.some((r) => r.length >= 2)),
    JSON.stringify(pp.lanes.map((l) => l.rounds.map((r) => r.length))),
  );
  const roundTok = pp.lanes.flatMap((l) =>
    l.rounds.map((r) => r.reduce((s, id) => s + chunkTok(byId.get(id)), 0)),
  );
  // Headroom: base + round diff + brief at its ceiling + 30k working room ≤ the 95k lane cap.
  // Literals here, so a constant moved in the tool cannot move the bar with it.
  // A docs-only diff is the SPEC lane's alone: lane B gets no chunk, so only lane A has a brief.
  check(
    'P1 docs-only diff: every chunk is spec, read by lane A only',
    pp.chunks.length > 0 &&
      pp.chunks.every((c) => c.kind === 'spec') &&
      pp.lanes[1]?.chunks.length === 0 &&
      pp.lanes[0]?.chunks.length === pp.chunks.length,
    JSON.stringify(pp.lanes.map((l) => [l.id, l.chunks.length])),
  );
  {
    // Stylesheets are the CONSUMER lane's alone; code beside them is still read by both lanes.
    const { dir: sd, base: sb } = repo('st-style', {
      'web/a.module.css': '.a { color: red; }\n'.repeat(20),
      'web/a.ts': 'export const a = (x) => x + 1\n'.repeat(20),
    });
    const sout = path.join(sd, '.plan');
    const sr = run(
      'plan',
      '--repo',
      sd,
      '--base',
      sb,
      '--out',
      sout,
      '--slug',
      'st',
      '--scope',
      'style',
    );
    const sp = existsSync(path.join(sout, 'plan.json'))
      ? JSON.parse(readFileSync(path.join(sout, 'plan.json'), 'utf8'))
      : { chunks: [], lanes: [] };
    const css = sp.chunks.find((c) => c.items.some((it) => it.path === 'web/a.module.css'));
    const ts = sp.chunks.find((c) => c.items.some((it) => it.path === 'web/a.ts'));
    const sA = existsSync(path.join(sout, 'lane-A-r1.prompt.md'))
      ? readFileSync(path.join(sout, 'lane-A-r1.prompt.md'), 'utf8')
      : '';
    check(
      'S1 stylesheet: own style chunk, lane A only; code chunk read by both',
      sr.status === 0 &&
        css?.kind === 'style' &&
        css !== ts &&
        sp.lanes[0].chunks.includes(css.id) &&
        !sp.lanes[1].chunks.includes(css.id) &&
        sp.lanes.every((l) => l.chunks.includes(ts?.id)),
      sr.stderr +
        JSON.stringify(sp.chunks.map((c) => [c.id, c.kind, c.items.map((i) => i.path)])) +
        JSON.stringify(sp.lanes.map((l) => [l.id, l.chunks])),
    );
    check(
      "S1 stylesheet: lane A's brief tags it as its alone",
      /\[stylesheets, yours alone — no other lane reads them/.test(sA),
      sA.slice(0, 1500),
    );
  }
  {
    // Batched diffs: a few `git diff` processes for the whole change, not two per file (measured: 161 files,
    // 328 diff processes, 17 s on Windows), and each file's text the same bytes a per-file run prints — the
    // per-file rule re-derived here: plain; code → function context, or -U15 where that grows past FUNC_GROWTH.
    const bd = path.join(root, 'batch');
    mkdirSync(path.join(bd, 'svc'), { recursive: true });
    git(bd, 'init', '-q');
    git(bd, 'config', 'user.email', 't@t');
    git(bd, 'config', 'user.name', 't');
    const fnBody = (i, v, len) =>
      Array.from({ length: len }, (_, k) => `  const x${k} = ${k === 2 ? v : k};`).join('\n');
    const src = (i, v, len) => `export function f${i}(a) {\n${fnBody(i, v, len)}\n  return a;\n}\n`;
    const names = Array.from({ length: 12 }, (_, i) => `svc/m${i}.ts`);
    names.forEach((f, i) => writeFileSync(path.join(bd, f), src(i, 0, i % 3 === 0 ? 400 : 20)));
    writeFileSync(path.join(bd, 'svc', 'old name.ts'), src(99, 0, 20));
    writeFileSync(path.join(bd, 'notes.md'), 'a\n');
    // Two sources for one new file: the whole-tree numstat pairs d1 → a (exact) and lists d2 as deleted, but a
    // batch over [a, d2] alone pairs d2 → a — a section that is neither file's own diff.
    mkdirSync(path.join(bd, 'docs'));
    const prose = Array.from({ length: 30 }, (_, k) => `line ${k} of the shared text`);
    writeFileSync(path.join(bd, 'docs', 'd1.txt'), prose.join('\n') + '\n');
    writeFileSync(
      path.join(bd, 'docs', 'd2.txt'),
      prose.map((l, k) => (k % 15 === 3 ? `${l} (changed)` : l)).join('\n') + '\n',
    );
    git(bd, 'add', '-A');
    git(bd, 'commit', '-qm', 'base');
    const bb = git(bd, 'rev-parse', 'HEAD');
    names.forEach((f, i) => writeFileSync(path.join(bd, f), src(i, 7, i % 3 === 0 ? 400 : 20)));
    git(bd, 'mv', 'svc/old name.ts', 'svc/new name.ts');
    writeFileSync(path.join(bd, 'notes.md'), 'a\nb\n');
    git(bd, 'mv', 'docs/d1.txt', 'docs/a.txt');
    git(bd, 'rm', '-q', 'docs/d2.txt');
    git(bd, 'add', '-A');
    git(bd, 'commit', '-qm', 'head');
    const bh = git(bd, 'rev-parse', 'HEAD');
    const trace = path.join(root, 'batch-trace.log');
    const bout = path.join(bd, '.plan');
    const br = runEnv(
      { GIT_TRACE: trace },
      'plan',
      '--repo',
      bd,
      '--base',
      bb,
      '--out',
      bout,
      '--slug',
      'bt',
    );
    const diffs =
      (existsSync(trace) ? readFileSync(trace, 'utf8') : '').match(
        /built-in: git (?:-c \S+ )*diff /g,
      ) ?? [];
    check(
      'batched diffs: ≤ 8 `git diff` processes for 16 files',
      br.status === 0 && diffs.length <= 8,
      `${diffs.length} diff processes; ${br.stderr}`,
    );
    const packed = existsSync(path.join(bout, 'pack.diff'))
      ? readFileSync(path.join(bout, 'pack.diff'), 'utf8')
      : '';
    const one = (f, ...a) =>
      spawnSync(
        'git',
        ['-c', 'core.quotepath=false', '-C', bd, 'diff', '-M', ...a, bb, bh, '--', f],
        {
          encoding: 'utf8',
        },
      ).stdout.replace(/\n$/, '');
    const ctxs = new Set();
    const perFile = (f) => {
      const plain = one(f);
      if (!/\.ts$/.test(f) || !plain) return ctxs.add('default') && plain;
      const fn = one(f, '--function-context');
      const wide = fn.split('\n').length - plain.split('\n').length > mod.FUNC_GROWTH;
      ctxs.add(wide ? 'U15' : 'function');
      return wide ? one(f, '-U15') : fn;
    };
    const all = [...names, 'svc/new name.ts', 'notes.md', 'docs/a.txt', 'docs/d2.txt'];
    const missing = all.filter((f) => !packed.includes(perFile(f)));
    check(
      'batched diffs: every file in pack.diff byte-equal to its per-file diff (function, -U15, rename, docs)',
      packed.length > 0 &&
        missing.length === 0 &&
        ['default', 'function', 'U15'].every((c) => ctxs.has(c)),
      `missing: ${missing.join(', ')}; contexts ${[...ctxs]}`,
    );
  }
  const briefs = pp.lanes
    .filter((l) => l.rounds.length)
    .map((l) => path.join(pout, `lane-${l.id}-r1.prompt.md`))
    .filter(existsSync)
    .map((f) => readFileSync(f, 'utf8'));
  // 95k cap = the measured 24k base + brief ceiling + round + 30k for reads and probes; the round stays ≥25k
  // (measured on a bench run: ≈6.5k rounds meant 36 lane-rounds instead of 7).
  check(
    'P1 headroom: base 24k + the default round budget + brief ceiling + 30k ≤ 95k, round ≥ 25k',
    mod.LANE_CONTEXT === 95000 &&
      mod.BASE_TOKENS === 24000 &&
      mod.ROUND_TOKENS + mod.BRIEF_TOKENS + 24000 + 30000 <= 95000 &&
      mod.ROUND_TOKENS >= 25000,
    `${mod.ROUND_TOKENS} + ${mod.BRIEF_TOKENS}`,
  );
  check(
    'P1 headroom: every written brief is measured under the brief ceiling',
    briefs.length === pp.lanes.filter((l) => l.rounds.length).length &&
      briefs.length > 0 &&
      briefs.every(
        (s) =>
          mod.estTokens(Buffer.byteLength(s, 'utf8'), s.split('\n').length) <= mod.BRIEF_TOKENS,
      ),
    String(briefs.map((s) => Buffer.byteLength(s, 'utf8'))),
  );
  check(
    'P1 every lane-round + base 24k + brief ceiling + 30k working room ≤ 95k',
    roundTok.length > 0 && roundTok.every((t) => t + mod.BRIEF_TOKENS + 24000 + 30000 <= 95000),
    JSON.stringify(roundTok.map(Math.round)),
  );
  check(
    'P1 …so the diff takes more than one round per lane',
    pp.rounds > 1 && /rounds \d+/.test(pr.stdout),
    pr.stdout,
  );
  check('P1 the plan line prints the token sizing', /≈\d+k tokens/.test(pr.stdout), pr.stdout);
  const pwin = pp.chunks.flatMap((c) => c.pack ?? []);
  check(
    'P4 every window < 10k tokens by (bytes + 8·lines)/2.2',
    pwin.length > 0 && pwin.every((w) => est(ppack.slice(w.from - 1, w.to).join('\n')) < 10000),
    JSON.stringify(pwin.map((w) => Math.round(est(ppack.slice(w.from - 1, w.to).join('\n'))))),
  );

  // P3 data-file-as-prose-chunk: a JSON record baseline → ONE `data` chunk, ONE lane, a key-level summary.
  const rec = (i, extra = {}) => ({
    page: `en/p${i}.mdx`,
    rule: 'label',
    quote: `Q${i}`,
    ...extra,
  });
  const baseRecs = Array.from({ length: 60 }, (_, i) => rec(i));
  const headRecs = [
    ...baseRecs.slice(0, 37).map((r, i) => (i < 5 ? { ...r, ticket: 'PROJ-1' } : r)),
    rec(100),
    rec(101),
    rec(102),
  ];
  const dd = path.join(root, 'g8-data');
  mkdirSync(path.join(dd, 'scripts'), { recursive: true });
  git(dd, 'init', '-q');
  git(dd, 'config', 'user.email', 't@t');
  git(dd, 'config', 'user.name', 't');
  writeFileSync(
    path.join(dd, 'scripts', 'quote-baseline.json'),
    JSON.stringify(baseRecs, null, 2) + '\n',
  );
  writeFileSync(path.join(dd, 'scripts', 'conf.json'), '{"a": 1}\n');
  git(dd, 'add', '-A');
  git(dd, 'commit', '-qm', 'base');
  const db = git(dd, 'rev-parse', 'HEAD');
  writeFileSync(
    path.join(dd, 'scripts', 'quote-baseline.json'),
    JSON.stringify(headRecs, null, 2) + '\n',
  );
  writeFileSync(path.join(dd, 'scripts', 'conf.json'), '{"a": 2}\n');
  writeFileSync(path.join(dd, 'scripts', 'check.mjs'), lines(40));
  git(dd, 'add', '-A');
  git(dd, 'commit', '-qm', 'head');
  const dout = path.join(dd, '.plan');
  const dr = run(
    'plan',
    '--repo',
    dd,
    '--base',
    db,
    '--out',
    dout,
    '--slug',
    'g8d',
    '--scope',
    'docs',
  );
  const dp = existsSync(path.join(dout, 'plan.json'))
    ? JSON.parse(readFileSync(path.join(dout, 'plan.json'), 'utf8'))
    : { chunks: [], lanes: [] };
  const data = dp.chunks.filter((c) => c.kind === 'data');
  check(
    'P3 the baseline is ONE data chunk; conf.json (an object) stays code',
    dr.status === 0 &&
      data.length === 1 &&
      data[0].items.length === 1 &&
      data[0].items[0].path === 'scripts/quote-baseline.json' &&
      !data[0].items[0].from,
    JSON.stringify(dp.chunks.map((c) => [c.id, c.kind, c.items.map((i) => i.path)])) + dr.stderr,
  );
  const owners = dp.lanes.filter((l) => data[0] && l.chunks.includes(data[0].id));
  check(
    'P3 …owned by ONE lane (TEST: a baseline is what a check consumes)',
    owners.length === 1 && owners[0].artifacts.includes('TEST'),
    JSON.stringify(owners.map((l) => l.id)),
  );
  const DB = existsSync(path.join(dout, 'lane-B-r1.prompt.md'))
    ? readFileSync(path.join(dout, 'lane-B-r1.prompt.md'), 'utf8')
    : '';
  const DA = existsSync(path.join(dout, 'lane-A-r1.prompt.md'))
    ? readFileSync(path.join(dout, 'lane-A-r1.prompt.md'), 'utf8')
    : '';
  check(
    'P3 the owner prompt carries the key-level summary: base 60 → head 40, added 3, removed 23, changed 5',
    /base 60 → head 40/.test(DB) &&
      /added 3\b/.test(DB) &&
      /removed 23\b/.test(DB) &&
      /changed 5\b/.test(DB) &&
      /\(page, rule, quote\)/.test(DB) &&
      DB.includes('en/p101.mdx'),
    DB.slice(0, 3000),
  );
  check(
    'P3 the other lane never sees the data file',
    DA !== '' && !DA.includes('quote-baseline.json'),
    DA.slice(0, 1500),
  );

  // P6 journal-rounds-planned-not-run: rows for every file, yet round 2 never ran → not a pass.
  const { dir: rd, base: rb } = repo('g8-rounds', {
    'svc/a.go': lines(150),
    'ui/b.tsx': lines(150),
  });
  const rout = path.join(rd, '.plan');
  run('plan', '--repo', rd, '--base', rb, '--out', rout, '--per-round', '1');
  const rp = JSON.parse(readFileSync(path.join(rout, 'plan.json'), 'utf8'));
  const [c1, c2] = rp.chunks.map((c) => c.id);
  const rows = '| svc/a.go | read |\n| ui/b.tsx | read |\n';
  writeFileSync(path.join(rd, 'lane-A.md'), `# Lane A r1 — ${c1}\n${rows}`);
  writeFileSync(path.join(rd, 'lane-B.md'), `# Lane B r1 — ${c2}\n${rows}`);
  const rc = run(
    'check',
    '--plan',
    path.join(rout, 'plan.json'),
    path.join(rd, 'lane-A.md'),
    path.join(rd, 'lane-B.md'),
  );
  check(
    'P6 check: 2 planned rounds, only r1 ran → «rounds 1 of 2», exit 1',
    rc.status === 1 && /rounds 1 of 2/.test(rc.stdout) && !/rounds 2\b(?! of)/.test(rc.stdout),
    rc.stdout,
  );
  check(
    'P6 check: …the unrun round 2 is a RERUN per lane',
    new RegExp(`RERUN lane A: ${c2}\\b.*round 2`).test(rc.stdout) &&
      new RegExp(`RERUN lane B: ${c1}\\b.*round 2`).test(rc.stdout),
    rc.stdout,
  );
  writeFileSync(path.join(rd, 'lane-A-r2.md'), `# Lane A r2 — ${c2}\n${rows}`);
  writeFileSync(path.join(rd, 'lane-B-r2.md'), `# Lane B rerun — ${c1}\n${rows}`);
  const rc2 = run(
    'check',
    '--plan',
    path.join(rout, 'plan.json'),
    ...['lane-A.md', 'lane-B.md', 'lane-A-r2.md', 'lane-B-r2.md'].map((f) => path.join(rd, f)),
  );
  check(
    'P6 check: both rounds ran (by round number or by chunk list) → «rounds 2 of 2», exit 0',
    rc2.status === 0 && /rounds 2 of 2/.test(rc2.stdout) && !/RERUN/.test(rc2.stdout),
    rc2.stdout,
  );
  writeFileSync(path.join(rd, 'nohead.md'), rows);
  const rc3 = run('check', '--plan', path.join(rout, 'plan.json'), path.join(rd, 'nohead.md'));
  check(
    'P6 check: a report with no round header proves no round ran',
    rc3.status === 1 && /rounds 0 of 2/.test(rc3.stdout),
    rc3.stdout,
  );
  const rsk = run(
    'skeleton',
    '--plan',
    path.join(rout, 'plan.json'),
    path.join(rd, 'lane-A.md'),
    path.join(rd, 'lane-B.md'),
  );
  check(
    'P6 skeleton: the Ledger line carries executed rounds, never planned ones',
    /\*\*Ledger:\*\* 2\/2 files · lanes 2 · rounds 1 of 2/.test(rsk.stdout),
    rsk.stdout.slice(0, 1200),
  );

  // P7 lane-prompt-by-pointer: a 45 KB tickets file → the prompt stays ≤ 20 KB, verbatim-passable.
  const ticket = (k, verdicts) =>
    [
      `## ${k} — Узбекские страницы цитируют подписи`,
      `### Description`,
      `DESC-${k}: открыть страницу и сверить подписи. ${'Подпись «Model chaqiruvi» нет в каталоге. '.repeat(8)}`,
      `### Comments (${verdicts.length})`,
      '',
      ...verdicts.flatMap((v, i) => [
        `**Автор ${i}** · 2026-09-${String(10 + i).padStart(2, '0')}T10:00:00.000+0000`,
        v,
        `${'Длинное обсуждение расхождений каталога и страниц. '.repeat(60)}`,
        '',
      ]),
      '### Links',
      `- relates to PROJ-1`,
      '',
    ].join('\n');
  const tk = path.join(rd, 'tickets.md');
  writeFileSync(
    tk,
    [
      '# Tracker tasks — read by the panel',
      '',
      ticket('PROJ-1063', [
        '*Для QA* шаги',
        'Ретест 01.09 — *Pass* OLD-VERDICT-1063',
        'Ретест 30.09 — *Не исправлено полностью* LATEST-VERDICT-1063',
        'Дополнение ревьюера NOT-A-VERDICT',
      ]),
      ticket('PROJ-1487', [
        'Дополнение по ревью',
        'Проверка 01.10.2026 — *Pass* OLD-VERDICT-1487',
        'Найдено повторно',
        'Проверка 06.10.2026 — *Fail*, возвращаю. LATEST-VERDICT-1487',
      ]),
      ticket('PROJ-1714', ['Комментарий без вердикта NO-VERDICT-1714']),
    ].join('\n'),
  );
  const mrBig = path.join(rd, 'mr-big.md');
  writeFileSync(
    mrBig,
    `MR-HEAD: adds the baseline.\n${'Описание изменения и его причин. '.repeat(900)}\nMR-TAIL\n`,
  );
  const tr = run(
    'plan',
    '--repo',
    rd,
    '--base',
    rb,
    '--out',
    path.join(rd, '.plan7'),
    '--slug',
    'g8t',
    '--scope',
    'docs',
    '--tickets',
    tk,
    '--mr-text',
    mrBig,
  );
  const T = existsSync(path.join(rd, '.plan7', 'lane-A-r1.prompt.md'))
    ? readFileSync(path.join(rd, '.plan7', 'lane-A-r1.prompt.md'), 'utf8')
    : '';
  check(
    'P7 fixture: the tickets file is over 40 KB',
    statSync(tk).size > 40000,
    String(statSync(tk).size),
  );
  check(
    'P7 prompt ≤ 20 KB with a 40+ KB tickets file and a 30 KB MR text',
    tr.status === 0 && T !== '' && Buffer.byteLength(T, 'utf8') <= 20000,
    `${Buffer.byteLength(T, 'utf8')} B ${tr.stderr}`,
  );
  check(
    'P7 …every description kept, the latest QA verdict kept, older verdicts and chatter dropped',
    [
      'DESC-PROJ-1063',
      'DESC-PROJ-1487',
      'DESC-PROJ-1714',
      'LATEST-VERDICT-1063',
      'LATEST-VERDICT-1487',
    ].every((s) => T.includes(s)) &&
      !T.includes('OLD-VERDICT') &&
      !T.includes('NOT-A-VERDICT'),
    T.slice(-4000),
  );
  check(
    'P7 …the full tickets file and the cut MR text are named by path',
    T.includes(tk) && T.includes(mrBig) && T.includes('MR-HEAD') && !T.includes('MR-TAIL'),
    T.slice(-2500),
  );
  check(
    'P7 …no «read the prompt file» stub',
    !/read it first|instructions are in the file/i.test(T),
  );

  // P8 deliverable-via-shell + P9 rerun-unchanged-tree: the template's own lines.
  const r9 = run(
    'plan',
    '--repo',
    rd,
    '--base',
    rb,
    '--out',
    path.join(rd, '.plan9'),
    '--slug',
    'g8r',
    '--scope',
    'docs',
    '--tests-record',
    '.agent/tmp/review-g8r/tests-run.txt',
    '--tests-record',
    '.agent/tmp/review-g8r/content-check.log',
  );
  const N = existsSync(path.join(rd, '.plan9', 'lane-B-r1.prompt.md'))
    ? readFileSync(path.join(rd, '.plan9', 'lane-B-r1.prompt.md'), 'utf8')
    : '';
  check(
    'P8 template: deliverable is one Write, then Edit; never echo/heredoc',
    /one Write/i.test(N) &&
      /then (extend|grow) it with Edit/i.test(N) &&
      /never echo, a heredoc/i.test(N),
    N.slice(0, 2500),
  );
  check(
    'P8 template: the deliverable opens with the round header `check` counts',
    /# Lane B r1 — /.test(N),
    N.slice(0, 1500),
  );
  check(
    'P9 --tests-record takes several records; the prompt names each as the clean-head baseline',
    r9.status === 0 &&
      N.includes('tests-run.txt') &&
      N.includes('content-check.log') &&
      /clean-head baseline/i.test(N) &&
      /never re-run the suite or an existing test package/.test(N),
    N.slice(-2500),
  );
  const n9 = run(
    'prompt',
    '--plan',
    path.join(rd, '.plan9', 'plan.json'),
    '--lane',
    'A',
    '--slug',
    'g8r',
    '--tests-record',
    'x.log,y.log',
  );
  check(
    'P9 prompt --tests-record a,b names both',
    n9.status === 0 && n9.stdout.includes('x.log') && n9.stdout.includes('y.log'),
    n9.stdout.slice(-1500) + n9.stderr,
  );

  // D-4 continuation: the tier and the lane choice live in plan.json; `status` reads them back.
  const riskJson = path.join(rd, 'risk.json');
  writeFileSync(
    riskJson,
    JSON.stringify({
      tier: 'T2',
      markers: [{ why: 'RBAC-маршрут', where: 'svc/a.go' }],
      files: ['svc/a.go'],
    }),
  );
  run(
    'plan',
    '--repo',
    rd,
    '--base',
    rb,
    '--out',
    path.join(rd, '.planD'),
    '--slug',
    'g8s',
    '--scope',
    'MR !9',
    '--risk',
    riskJson,
    '--per-round',
    '1',
  );
  const st = run(
    'status',
    '--plan',
    path.join(rd, '.planD', 'plan.json'),
    path.join(rd, 'lane-A.md'),
    path.join(rd, 'lane-B.md'),
  );
  check(
    'D-4 status: tier + markers, lanes, rounds run, next step — from plan.json alone',
    st.status === 0 &&
      /tier: T2/.test(st.stdout) &&
      /RBAC-маршрут — svc\/a\.go/.test(st.stdout) &&
      /lanes 2: A CONSUMER \+ SPEC · B TEST \+ AUTHZ/.test(st.stdout) &&
      /rounds 1 of 2/.test(st.stdout) &&
      /RERUN lane A/.test(st.stdout),
    st.stdout + st.stderr,
  );
  const sk2 = run('skeleton', '--plan', path.join(rd, '.planD', 'plan.json'));
  check(
    'D-4 skeleton: Tier filled from the stored tier',
    /\*\*Tier:\*\* T2 — RBAC-маршрут — svc\/a\.go/.test(sk2.stdout),
    sk2.stdout.slice(0, 900),
  );
  const riskTxt = path.join(rd, 'risk.txt');
  writeFileSync(
    riskTxt,
    'VERIFICATION TIER: T1 · base abc · files 2 (behavioural 2)\n\nWhat raised the tier:\n  · new route — ui/b.tsx\n',
  );
  run(
    'plan',
    '--repo',
    rd,
    '--base',
    rb,
    '--out',
    path.join(rd, '.planT'),
    '--risk',
    riskTxt,
    '--scratch',
    'none',
  );
  const pt = JSON.parse(readFileSync(path.join(rd, '.planT', 'plan.json'), 'utf8'));
  check(
    'D-4 plan --risk reads the text output too',
    pt.risk?.tier === 'T1' && pt.risk.markers?.[0] === 'new route — ui/b.tsx',
    JSON.stringify(pt.risk),
  );
  const st0 = run('status', '--plan', path.join(rd, '.planT', 'plan.json'));
  check(
    'D-4 status: no reports yet → «rounds 0 of N» and the round-1 spawn as next',
    st0.status === 0 && /rounds 0 of/.test(st0.stdout) && /next:/.test(st0.stdout),
    st0.stdout + st0.stderr,
  );
}

{
  // plan.json keeps ≤400 items per data section with `total`: the prompt must count the real total.
  const { renderData } = await import(pathToFileURL(TOOL).href);
  const r = renderData(
    { head: 'DATA x', sections: [{ title: 'removed', items: ['- a', '- b'], total: 500 }] },
    Infinity,
    'FULL.txt',
  );
  check(
    'P3 data: a stored section cut to 400 items still counts its total',
    r.includes('removed (500):') && r.includes('… +498 more — the whole list: FULL.txt'),
    r,
  );
}

// Measured: a markdown ticket (`# KEY — …`, `## Requirements`… with no `###`) passed whole → 25–31 KB prompts;
// run.json records named by path only were cat'ed by lanes; the stub is the default spawn.
{
  const { trimTickets, fitBlocks, recordLine, stubOf } = await import(pathToFileURL(TOOL).href);
  const B = (s) => Buffer.byteLength(s, 'utf8');
  const para = (tag, n) =>
    `${tag}: ${'Роль видит только разрешённые разделы, кнопки без права скрыты. '.repeat(n)}${tag}-END`;
  // The markdown-ticket shape: a lang marker, `# KEY — title`, a link line, `## ` sections, no `###`, Russian.
  const md = [
    '<!-- lang:ru --> (данные трекера)',
    '# PROJ-55 — Доработка интерфейса под права роли',
    'https://tracker.example.com/browse/PROJ-55 · статус В работе',
    '',
    ...[
      'Решения',
      'Права и роли',
      'Требования',
      'Хвосты',
      'Критерии приёмки',
      'Примеры-кейсы',
    ].flatMap((h, i) => [
      `## ${h}`,
      para(`SEC${i}`, 24),
      ...(i === 2 ? ['### Подробности', 'SUB-KEPT уточнение требования'] : []),
      '',
    ]),
  ].join('\n');
  check('T1 fixture: the markdown ticket is ≥ 15 KB of 2-byte text', B(md) > 15000, String(B(md)));
  check(
    'T1 trimTickets: a text with no `## KEY-n` header is not the tickets-file shape — back unchanged',
    trimTickets(md, 3000) === md,
  );
  const panel = (k, desc, verdicts) =>
    [
      `## ${k} — Страница ролей`,
      '',
      'Status: In QA · type: Bug',
      `https://tracker.example.com/browse/${k}`,
      '',
      '### Description',
      '',
      `DESC-${k} ${desc}`,
      '',
      `### Comments (${verdicts.length})`,
      ...verdicts.flatMap((v, i) => [
        '',
        `**Автор ${i}** · 2026-10-${String(10 + i).padStart(2, '0')}T10:00:00.000+0000`,
        `${v} ${'обсуждение '.repeat(120)}`,
      ]),
      '',
      '### Links',
      '',
      '- relates to PROJ-1',
      '',
    ].join('\n');
  const p1 = panel(
    'PROJ-7',
    `${'шаги воспроизведения '.repeat(80)}\n## Шаги\n${'шаг '.repeat(200)} INNER-H2`,
    ['Ретест 01.10 — *Pass* OLD-V7', 'Ретест 20.10 — *Fail* LATEST-V7'],
  );
  const p2 = panel('PROJ-8', 'короткое описание', ['Проверка 02.10.2026 — *Pass* LATEST-V8']);
  const tf = ['# Tracker tasks — read by the panel', '', p1, p2].join('\n');
  const one = trimTickets(p1);
  check(
    'T2 panel shape, ONE ticket (was: < 2 parts → back whole): trimmed to description + latest verdict',
    one.includes('DESC-PROJ-7') &&
      one.includes('LATEST-V7') &&
      !one.includes('OLD-V7') &&
      !one.includes('relates to PROJ-1'),
    one.slice(-600),
  );
  check(
    'T2 …a `## Шаги` inside the description stays description, never a ticket of its own',
    one.includes('INNER-H2') && one.indexOf('INNER-H2') < one.indexOf('### Comments'),
  );
  for (const n of [600, 2000, 5000]) {
    const t = trimTickets(tf, n);
    check(
      `T2 panel shape ≤ budget ${n} (got ${B(t)}); each title is its header line alone`,
      B(t) <= n &&
        t.includes('## PROJ-7 — Страница ролей\n') &&
        t.includes('## PROJ-8 — Страница ролей'),
      t.slice(0, 400),
    );
  }
  const t2 = trimTickets(tf, 5000);
  check(
    'T2 …status line kept as description, latest verdicts kept under the budget',
    t2.includes('Status: In QA') && t2.includes('LATEST-V8') && t2.includes('DESC-PROJ-8'),
    t2,
  );
  // A ticket whose head (before the first `###`) is long and whose title line is huge: the head is cuttable
  // description, the title is cut too, the latest verdict keeps its third.
  const longHead = [
    `## PROJ-9 — ${'заголовок '.repeat(200)}`,
    para('HEAD9', 40),
    '### Comments (1)',
    '',
    '**QA** · 2026-10-21T10:00:00.000+0000',
    'Ретест 21.10 — *Pass* LATEST-V9',
  ].join('\n');
  const lh = trimTickets(longHead, 900);
  check(
    `T2b long head + huge title ≤ 900 (got ${B(lh)}), the latest verdict kept, the head cut`,
    B(lh) <= 900 &&
      lh.startsWith('## PROJ-9 — заголовок') &&
      lh.includes('LATEST-V9') &&
      lh.includes('\nHEAD9:') &&
      !lh.includes('HEAD9-END'),
    lh.slice(-300),
  );
  const mixed = [md, '', p1, p2].join('\n');
  check(
    'T3 mixed under budget: the preamble is text, its `## `/`###` sections kept (never parsed as tickets and their «other sections» dropped)',
    trimTickets(mixed).includes('SUB-KEPT') && trimTickets(mixed).includes('SEC5-END'),
  );
  check(
    'T3 a budget too small for any text: ≤ budget, never a pile of « …» marks',
    B(trimTickets(tf, 10)) <= 10 && B(trimTickets(mixed, 10)) <= 10,
    JSON.stringify([trimTickets(tf, 10), trimTickets(mixed, 10)]),
  );
  for (const n of [1500, 6000, 12000]) {
    const t = trimTickets(mixed, n);
    check(
      `T3 mixed (markdown preamble + panel tickets) ≤ budget ${n} (got ${B(t)}): preamble cut, never kept whole`,
      B(t) <= n &&
        t.startsWith('<!-- lang:ru -->') &&
        !t.includes('SEC5-END') &&
        t.includes('## PROJ-7 — Страница ролей') &&
        t.includes('## PROJ-8'),
      t.slice(0, 300),
    );
  }
  // fitBlocks: a fit that ignores its share falls back to a plain cut; many blocks with long ids stay ≤ room.
  const big = para('BIG', 60);
  const fb = fitBlocks(
    [
      {
        id: 'ticket:x.md',
        file: '/abs/x.md',
        text: big,
        body: big,
        fit: () => big,
        trimmed: false,
      },
    ],
    3000,
  );
  check(
    'T4 fitBlocks: a fit over its share falls back to cutBytes, the block ≤ room',
    fb.length === 1 &&
      B(fb.join('\n')) <= 3000 &&
      fb[0].includes('BIG:') &&
      !fb[0].includes('BIG-END'),
    String(B(fb.join('\n'))),
  );
  const many = Array.from({ length: 6 }, (_, i) => ({
    id: `mr:${'very-long-description-file-name-'.repeat(3)}${i}.md`,
    file: `/abs/${'deep/'.repeat(20)}${i}.md`,
    text: `${para(`M${i}`, 10)} </mr_text> ${'</mr_text>'.repeat(40)}`,
    fit: null,
    trimmed: false,
  })).map((b) => ({ ...b, body: b.text }));
  // No space or line end: cutBytes cuts at the exact byte, so an under-counted overhead shows (escapes, digits).
  const dense = Array.from({ length: 6 }, (_, i) => ({
    id: `mr:d${i}.md`,
    file: `/abs/d${i}.md`,
    text: `${'Ж</mr_text>'.repeat(400)}${i}`,
    fit: null,
    trimmed: false,
  })).map((b) => ({ ...b, body: b.text }));
  for (const room of [3000, 9000]) {
    const out = fitBlocks(dense, room);
    check(
      `T4 fitBlocks: dense blocks cut at the exact byte, total + joins ≤ room ${room} (got ${out.reduce((s, x) => s + B(x) + 1, 0)})`,
      out.reduce((s, x) => s + B(x) + 1, 0) <= room,
    );
  }
  for (const room of [2500, 6000]) {
    const out = fitBlocks(many, room);
    check(
      `T4 fitBlocks: 6 blocks, long ids and escapes, total + joins ≤ room ${room} (got ${out.reduce((s, x) => s + B(x) + 1, 0)})`,
      out.reduce((s, x) => s + B(x) + 1, 0) <= room,
    );
  }

  // End to end: plan --tickets <markdown ticket> → every written prompt ≤ PROMPT_MAX; the cut block names its file.
  const { dir: gd, base: gb } = repo('g9', { 'ui/roles.tsx': lines(60), 'ui/menu.tsx': lines(40) });
  const tkf = path.join(gd, 'ticket-PROJ-55.md');
  writeFileSync(tkf, mixed);
  mkdirSync(path.join(gd, '.agent', 'tests', 'runs'), { recursive: true });
  const runJson = (fail) =>
    JSON.stringify({
      id: 'r1',
      status: 'done',
      commit: 'abcdef1234567890',
      results: Array.from({ length: 12 }, (_, i) => ({
        groupId: 'roles',
        caseId: `roles-${i}`,
        status: i < fail ? 'failed' : 'passed',
        note: 'x'.repeat(3000),
      })),
      summary: { total: 12, passed: 12 - fail, failed: fail, skipped: 0, blocked: 0 },
      tests: { passed: 431, failed: fail, skipped: 2 },
    });
  writeFileSync(path.join(gd, '.agent', 'tests', 'runs', 'a.run.json'), runJson(2));
  writeFileSync(path.join(gd, '.agent', 'tests', 'runs', 'b.run.json'), runJson(11));
  const gr = run(
    'plan',
    '--repo',
    gd,
    '--base',
    gb,
    '--out',
    path.join(gd, '.plan'),
    '--slug',
    'g9',
    '--scope',
    'roles UI',
    '--tickets',
    tkf,
    '--tests-record',
    '.agent/tests/runs/a.run.json',
    '--tests-record',
    '.agent/tests/runs/b.run.json',
    '--tests-record',
    '.agent/tmp/e6-alltests.log',
    '--tests-record',
    '.agent/tests/runs/missing.run.json',
  );
  const prompts = ['A', 'B']
    .map((l) => path.join(gd, '.plan', `lane-${l}-r1.prompt.md`))
    .filter(existsSync);
  check(
    'T5 plan --tickets <markdown ticket>: both prompts written, each ≤ 20000 B',
    gr.status === 0 && prompts.length === 2 && prompts.every((f) => statSync(f).size <= 20000),
    `${prompts.map((f) => statSync(f).size)} ${gr.stderr}`,
  );
  const G = prompts.length ? readFileSync(prompts[0], 'utf8') : '';
  check(
    'T5 …the ticket block is cut, its head kept, its full file named',
    G.includes('# PROJ-55 — Доработка') &&
      G.includes(`cut at `) &&
      G.includes(tkf) &&
      !G.includes('SEC5-END'),
    G.slice(-900),
  );
  check(
    'T6 run.json record: result inline — status, commit, case counts, tests tally, failed ids',
    G.includes(
      '.agent/tests/runs/a.run.json (done at abcdef123456: 12 cases — 10 passed, 2 failed, 0 skipped; tests 431 passed, 2 failed, 2 skipped; failed roles:roles-0, roles:roles-1)',
    ),
    (G.match(/Clean-head baseline[^\n]*/) ?? [''])[0].slice(0, 900),
  );
  check(
    'T6 …failed ids capped at 8 with «… +n»',
    G.includes(
      'failed roles:roles-0, roles:roles-1, roles:roles-2, roles:roles-3, roles:roles-4, roles:roles-5, roles:roles-6, roles:roles-7 … +3)',
    ),
    (G.match(/b\.run\.json[^·]*/) ?? [''])[0],
  );
  check(
    'T6 …a log and a missing record stay their path; lanes told to Grep a record, never cat it',
    G.includes(' · .agent/tmp/e6-alltests.log · .agent/tests/runs/missing.run.json.') &&
      /never a cat or a whole Read/.test(G),
  );
  check(
    'T6 recordLine: unparsable json → its path',
    (() => {
      const f = path.join(gd, 'bad.run.json');
      writeFileSync(f, '{nope');
      return recordLine(f) === f;
    })(),
  );
  check(
    'T7 plan prints the stub as the default spawn — guard literals in it, no «still pass it verbatim»',
    gr.stdout.includes(stubOf('<lane prompt file above>')) &&
      /\[return-format\]/.test(stubOf('x')) &&
      /\[no-subagents\]/.test(stubOf('x')) &&
      /Read it first, in one Read/.test(stubOf('x')) &&
      !/still pass it verbatim/.test(gr.stdout),
    gr.stdout.slice(-900),
  );

  // A core alone over the cap (a round of 160 long-named files) is printed loudly by plan and by prompt.
  // 03.11: paths no longer repeat in the sweep command, so the names are longer and the rounds the old 35k.
  const wide = Object.fromEntries(
    Array.from({ length: 160 }, (_, i) => [
      `ui/${'nested-feature-folder/'.repeat(8)}component-${String(i).padStart(3, '0')}.tsx`,
      lines(2),
    ]),
  );
  const { dir: wd, base: wb } = repo('g9wide', wide);
  const wr = run(
    'plan',
    '--repo',
    wd,
    '--base',
    wb,
    '--out',
    path.join(wd, '.plan'),
    '--slug',
    'g9w',
    '--scope',
    'wide',
    '--per-round',
    '20',
    '--max-rounds',
    '20',
    '--round-tokens',
    '35473',
    '--chunk-tokens',
    '17736',
  );
  check(
    'T8 core over the cap → plan prints PROMPT OVER CAP with the core size and the --chunks way out',
    wr.status === 0 &&
      /PROMPT OVER CAP: .*lane-\w+-r1\.prompt\.md is \d+ B > 20000 B — its core alone .* is \d+ B/.test(
        wr.stdout,
      ) &&
      /--chunks <fewer ids>/.test(wr.stdout),
    wr.stdout.slice(-1500) + wr.stderr,
  );
  const wp = run(
    'prompt',
    '--plan',
    path.join(wd, '.plan', 'plan.json'),
    '--lane',
    'A1',
    '--slug',
    'g9w',
  );
  const wp2 =
    wp.status === 0
      ? wp
      : run(
          'prompt',
          '--plan',
          path.join(wd, '.plan', 'plan.json'),
          '--lane',
          'A',
          '--slug',
          'g9w',
        );
  check(
    'T8 …and `prompt` says it on stderr',
    wp2.status === 0 && /PROMPT OVER CAP: this prompt/.test(wp2.stderr),
    wp2.stderr.slice(0, 600),
  );
}

// F2: test bodies and parity-covered translations are lane B's alone; a lane hands back at ≈95k.
{
  const { contextLine, twinOf } = await import(pathToFileURL(TOOL).href);
  const set = new Set(['i18n/a.ru.json', 'docs/ru/x.mdx']);
  check(
    'F2 twinOf: a locale suffix and a locale segment both find the ru twin; the source and an orphan none',
    twinOf('i18n/a.en.json', 'ru', set) === 'i18n/a.ru.json' &&
      twinOf('docs/uz/x.mdx', 'ru', set) === 'docs/ru/x.mdx' &&
      twinOf('i18n/a.ru.json', 'ru', set) === null &&
      twinOf('docs/ru/x.mdx', 'ru', set) === null &&
      twinOf('docs/en/y.mdx', 'ru', set) === null &&
      twinOf('i18n/b.en.json', 'ru', set) === null,
  );
  const files = {
    'ui/a.tsx': lines(100),
    'ui/a.test.tsx': lines(100),
    'ui/b.tsx': lines(100),
    'ui/b.test.tsx': lines(100),
    'docs/ru/x.mdx': lines(30),
    'docs/en/x.mdx': lines(30),
    'docs/uz/x.mdx': lines(30),
    'docs/en/only.mdx': lines(30),
  };
  const { dir, base } = repo('f2', files);
  const plain = run(
    'plan',
    '--repo',
    dir,
    '--base',
    base,
    '--out',
    path.join(dir, '.p0'),
    '--per-round',
    '1',
    '--max-rounds',
    '20',
  );
  const p0 = JSON.parse(readFileSync(path.join(dir, '.p0', 'plan.json'), 'utf8'));
  const [A0, B0] = p0.lanes;
  const chunkOf = (p, f) => p.chunks.find((c) => c.items.some((it) => it.path === f));
  const testIds = p0.chunks.filter((c) => c.kind === 'test').map((c) => c.id);
  check(
    'F2 tests: a test file sits in a test chunk, code and tests never share one',
    plain.status === 0 &&
      chunkOf(p0, 'ui/a.test.tsx')?.kind === 'test' &&
      !chunkOf(p0, 'ui/a.tsx')?.kind &&
      p0.chunks.every((c) =>
        c.items.every((it) => /\.test\.tsx$/.test(it.path) === (c.kind === 'test')),
      ),
    JSON.stringify(p0.chunks.map((c) => [c.id, c.kind, c.items.map((i) => i.path)])),
  );
  check(
    'F2 tests: interleaved x.tsx / x.test.tsx cut 2 chunks in the zone, not one per file',
    p0.chunks.filter((c) => c.zone === 'ui').length === 2,
    String(p0.chunks.filter((c) => c.zone === 'ui').length),
  );
  check(
    'F2 tests: lane B reads every test chunk, lane A none',
    testIds.length > 0 && testIds.every((id) => B0.chunks.includes(id) && !A0.chunks.includes(id)),
    JSON.stringify({ A: A0.chunks, B: B0.chunks, testIds }),
  );
  check(
    'F2 no --parity: translated docs stay docs (lane A), the summary says so',
    A0.chunks.includes(chunkOf(p0, 'docs/en/x.mdx').id) &&
      /translations are read as their own files: no --parity/.test(plain.stdout) &&
      /SPEC lanes only: 4 docs\/contract files/.test(plain.stdout),
    plain.stdout,
  );
  check(
    'F2 lane-rounds: A skips the tests, B the docs, so the sum is below two readers per chunk, and the summary prints it',
    p0.laneRounds === A0.rounds.length + B0.rounds.length &&
      p0.laneRounds < 2 * p0.chunks.length &&
      plain.stdout.includes(`lane-rounds ${p0.laneRounds}`),
    `${A0.rounds.length}/${B0.rounds.length} ${p0.laneRounds} of ${p0.chunks.length}`,
  );

  const par = run(
    'plan',
    '--repo',
    dir,
    '--base',
    base,
    '--out',
    path.join(dir, '.p1'),
    '--per-round',
    '1',
    '--max-rounds',
    '20',
    '--parity',
    'content:check',
    '--slug',
    'f2',
  );
  const p1 = JSON.parse(readFileSync(path.join(dir, '.p1', 'plan.json'), 'utf8'));
  const [A1, B1] = p1.lanes;
  const tr = chunkOf(p1, 'docs/en/x.mdx');
  check(
    'F2 --parity: en/uz with the ru twin in the diff → one i18n chunk, twin recorded',
    par.status === 0 &&
      tr?.kind === 'i18n' &&
      chunkOf(p1, 'docs/uz/x.mdx') === tr &&
      tr.items.every((it) => it.twin === 'docs/ru/x.mdx'),
    JSON.stringify(tr),
  );
  check(
    'F2 --parity: the ru source and a translation without a twin stay docs (spec), read by lane A only',
    chunkOf(p1, 'docs/ru/x.mdx').kind === 'spec' &&
      chunkOf(p1, 'docs/en/only.mdx').kind === 'spec' &&
      A1.chunks.includes(chunkOf(p1, 'docs/en/only.mdx').id) &&
      !B1.chunks.includes(chunkOf(p1, 'docs/en/only.mdx').id),
    JSON.stringify(p1.chunks.map((c) => [c.id, c.kind])),
  );
  check(
    "F2 --parity: the i18n chunk is lane B's alone, never a SPEC row",
    B1.chunks.includes(tr.id) &&
      !A1.chunks.includes(tr.id) &&
      !(p1.spec ?? []).some((s) => s.path === 'docs/en/x.mdx'),
    JSON.stringify(p1.spec),
  );
  check(
    'F2 --parity: the summary counts them under the check',
    /TEST lanes only: 2 test files, 2 translations \(twin in the diff, parity: content:check\)/.test(
      par.stdout,
    ),
    par.stdout,
  );
  const readA = (p) =>
    p.lanes[0].chunks.reduce((s, id) => s + p.chunks.find((c) => c.id === id).lines, 0);
  check(
    'F2 --parity: lane A reads the ru twin only — its changed lines drop by both translations',
    readA(p0) - readA(p1) === 60,
    `${readA(p0)} → ${readA(p1)}`,
  );

  const prompt = (lane, chunks) =>
    run(
      'prompt',
      '--plan',
      path.join(dir, '.p1', 'plan.json'),
      '--lane',
      lane,
      '--slug',
      'f2',
      '--chunks',
      chunks,
    );
  const pa = prompt('A', A1.chunks.join(','));
  const pb = prompt('B', [chunkOf(p1, 'ui/a.test.tsx').id, tr.id].join(','));
  check(
    "F2 prompt A: told never to read a test file, translations are the ru twin's, no test path listed",
    pa.status === 0 &&
      /never read a test file/.test(pa.stdout) &&
      /a translation's claims are its ru twin's/.test(pa.stdout) &&
      /\(B\)/.test(pa.stdout) &&
      !pa.stdout.includes('ui/a.test.tsx'),
    pa.stdout.slice(0, 1500) + pa.stderr,
  );
  check(
    'F2 prompt B: tests and translations tagged as its alone, twin named, no «never read» line',
    pb.status === 0 &&
      /\[tests, yours alone/.test(pb.stdout) &&
      /\[translations, yours alone\]: docs\/en\/x\.mdx ← docs\/ru\/x\.mdx · docs\/uz\/x\.mdx ← docs\/ru\/x\.mdx/.test(
        pb.stdout,
      ) &&
      /parity content:check/.test(pb.stdout) &&
      !/never read a test file/.test(pb.stdout),
    pb.stdout.slice(0, 1500) + pb.stderr,
  );
  const cl = contextLine(6000);
  check(
    'F2 contextLine: ≈95k cap, the 24k base, the brief and the round counted, the rest left, hand back with RERUN for the unread',
    /Context cap ≈95k tokens/.test(cl) &&
      /your base ≈24k/.test(cl) &&
      /this brief \(≤ 10k\)/.test(cl) &&
      /round's diff \(≈6k\)/.test(cl) &&
      /hand back at once/.test(cl) &&
      /RERUN/.test(cl) &&
      /leave ≈55k/.test(cl),
    cl,
  );
  check(
    'F2 contextLine: in every lane prompt',
    pa.stdout.includes('Context cap ≈95k tokens') && pb.stdout.includes('Context cap ≈95k tokens'),
  );
  // The kit has no fixed install path: the sweep call names the review-sweep beside this review-plan, quoted.
  const sweepCall = `node "${path.dirname(TOOL).replace(/\\/g, '/')}/review-sweep.mjs" all --base `;
  check(
    "kit: the lane prompt's sweep call names the review-sweep beside the tool, quoted",
    pa.stdout.includes(sweepCall),
    (pa.stdout.match(/^Sweep, .*$/m) ?? [''])[0].slice(0, 300),
  );
}

// Measured (290 lanes: 46 turns, 1.09 calls/turn, peak context median 134k, ~75% of tool output = code read
// around hunks piecemeal): function context, callers, sweep paths by file, waves, candidates, lessons, lint, notes.
{
  // A repo whose files exist at base too (modified, not added): function context only shows on a modification.
  const repo2 = (name, baseFiles, headFiles) => {
    const dir = path.join(root, name);
    mkdirSync(dir, { recursive: true });
    git(dir, 'init', '-q');
    git(dir, 'config', 'user.email', 't@t');
    git(dir, 'config', 'user.name', 't');
    const put = (fs) => {
      for (const [f, t] of Object.entries(fs)) {
        mkdirSync(path.dirname(path.join(dir, f)), { recursive: true });
        writeFileSync(path.join(dir, f), t);
      }
    };
    put(baseFiles);
    git(dir, 'add', '-A');
    git(dir, 'commit', '-qm', 'base');
    const base = git(dir, 'rev-parse', 'HEAD');
    put(headFiles);
    git(dir, 'add', '-A');
    git(dir, 'commit', '-qm', 'head');
    return { dir, base };
  };
  const fill = (n, tag) =>
    Array.from({ length: n }, (_, i) => `\t${tag}${i} := ${i} // filler ${i}`).join('\n');
  const goA = (op) =>
    `package svc\n\nfunc Helper() int {\n\treturn 1\n}\n\nfunc ComputeTotal(xs []int) int {\n\ttotal := 0\n${fill(30, 'a')}\n\tfor _, x := range xs {\n\t\ttotal ${op} x\n\t}\n${fill(10, 'b')}\n\treturn total\n}\n`;
  const goBig = (v) =>
    `package svc\n\nfunc Huge() {\n${fill(200, 'h')}\n\tchanged := ${v}\n${fill(200, 'k')}\n}\n`;
  const md = (v) =>
    Array.from({ length: 40 }, (_, i) =>
      i === 19 ? `Doc line 19 says ${v}.` : `Doc line ${i}.`,
    ).join('\n') + '\n';
  const ts = (body) => `export function formatMoney(n: number): string { return ${body} }\n`;
  const same = {
    'other/use.go':
      'package other\n\nimport "x/svc"\n\nfunc Use() int {\n\treturn svc.ComputeTotal(nil)\n}\n',
    'other2/homonym.go': 'package other2\n\nfunc X() int {\n\treturn ComputeTotal(nil)\n}\n',
    'svc/a_test.go': 'package svc\n\nfunc TestX() { ComputeTotal(nil) }\n',
    'ui/page.tsx':
      "import { formatMoney } from './lib'\nconst x = 1\nexport const Page = () => formatMoney(x)\n",
  };
  const { dir, base } = repo2(
    'fn-ctx',
    {
      ...same,
      'svc/a.go': goA('+='),
      'svc/big.go': goBig(1),
      'docs/a.md': md('one'),
      'ui/lib.ts': ts('String(n)'),
    },
    {
      'svc/a.go': goA('-='),
      'svc/big.go': goBig(2),
      'docs/a.md': md('two'),
      'ui/lib.ts': ts('n.toFixed(2)'),
    },
  );
  const out = path.join(dir, '.plan');
  const r = run(
    'plan',
    '--repo',
    dir,
    '--base',
    base,
    '--out',
    out,
    '--slug',
    'fn',
    '--scope',
    'fn ctx',
    '--note',
    'NO rerun rounds — exactly two spawns',
  );
  check('N plan runs', r.status === 0, r.stderr + r.stdout);
  const p = JSON.parse(readFileSync(path.join(out, 'plan.json'), 'utf8'));
  const packText = readFileSync(path.join(out, 'pack.diff'), 'utf8');
  const sect = (f) => {
    const i = packText.indexOf(`diff --git a/${f} `);
    const j = packText.indexOf('\ndiff --git', i + 1);
    return i < 0 ? '' : packText.slice(i, j < 0 ? undefined : j);
  };

  // c. Function context: the enclosing function of a code hunk is in the pack; >150 lines of growth → -U15.
  check(
    'N-c code file: the pack carries the whole enclosing function (git diff -W), not 3 lines',
    p.context?.['svc/a.go'] === 'function' &&
      sect('svc/a.go').includes('func ComputeTotal(xs []int) int {') &&
      sect('svc/a.go').includes('a0 := 0') &&
      sect('svc/a.go').includes('return total'),
    sect('svc/a.go').slice(0, 600),
  );
  check(
    'N-c a function growing the file by >150 lines falls back to -U15',
    p.context?.['svc/big.go'] === 'U15' &&
      !/\n func Huge\(\)/.test(sect('svc/big.go')) &&
      sect('svc/big.go').includes('h186 := 186') &&
      !sect('svc/big.go').includes('h180 := 180'),
    sect('svc/big.go').slice(0, 400),
  );
  check(
    'N-c docs keep the default context',
    !p.context?.['docs/a.md'] &&
      sect('docs/a.md').includes('Doc line 16.') &&
      !sect('docs/a.md').includes('Doc line 10.'),
    sect('docs/a.md'),
  );
  const plainTok = (f) => {
    const d = spawnSync('git', ['-C', dir, 'diff', '-M', base, 'HEAD', '--', f], {
      encoding: 'utf8',
    }).stdout.replace(/\n$/, '');
    return (Buffer.byteLength(d, 'utf8') + 8 * d.split('\n').length) / 2.2;
  };
  const chunkOfF = (f) => p.chunks.find((c) => c.items.some((it) => it.path === f));
  check(
    'N-c sizing counts the larger pack: the chunk of svc/a.go weighs more than its default-context diff',
    chunkOfF('svc/a.go') &&
      chunkOfF('svc/a.go').tokens > plainTok('svc/a.go') + plainTok('svc/big.go'),
    `${chunkOfF('svc/a.go')?.tokens} vs ${Math.round(plainTok('svc/a.go') + plainTok('svc/big.go'))}`,
  );
  check(
    'N-c the summary names the pack context',
    /pack context: 2 code files with whole enclosing functions \(git diff -W\), 1 at -U15/.test(
      r.stdout,
    ) ||
      /pack context: 1 code files with whole enclosing functions \(git diff -W\), 1 at -U15/.test(
        r.stdout,
      ),
    r.stdout,
  );

  // d. Callers outside the diff, path:line, in the CONSUMER lane only.
  const A = readFileSync(path.join(out, 'lane-A-r1.prompt.md'), 'utf8');
  const B = readFileSync(path.join(out, 'lane-B-r1.prompt.md'), 'utf8');
  check(
    'N-d Go: a qualified caller outside the diff is listed as path:line',
    /callers outside the diff \(git grep[^)]*\): [^\n]*other\/use\.go:6 \(ComputeTotal\)/.test(A),
    (A.match(/callers outside[^\n]*/g) ?? []).join('\n'),
  );
  check(
    'N-d Go: an unqualified homonym in another package and a test caller are not',
    !A.includes('other2/homonym.go') && !A.includes('svc/a_test.go'),
    (A.match(/callers outside[^\n]*/g) ?? []).join('\n'),
  );
  check(
    'N-d TS: the call line of an importer, not its import line',
    /ui\/page\.tsx:3 \(formatMoney\)/.test(A),
    (A.match(/callers outside[^\n]*/g) ?? []).join('\n'),
  );
  check('N-d the TEST + AUTHZ lane gets no callers list', !/callers outside the diff/.test(B));
  const riskJson = path.join(dir, 'risk.json');
  writeFileSync(
    riskJson,
    JSON.stringify({
      tier: 'T2',
      markers: [],
      radius: {
        consumers: [
          { file: 'other/use.go', hop: 1, via: 'svc/a.go', sym: 'ComputeTotal', inDiff: false },
          { file: 'svc/a.go', hop: 1, via: 'ui/lib.ts', sym: 'x', inDiff: true },
        ],
      },
    }),
  );
  run(
    'plan',
    '--repo',
    dir,
    '--base',
    base,
    '--out',
    path.join(dir, '.planR'),
    '--risk',
    riskJson,
    '--scratch',
    'none',
  );
  const pr = JSON.parse(readFileSync(path.join(dir, '.planR', 'plan.json'), 'utf8'));
  const cr = pr.chunks.find((c) => c.items.some((it) => it.path === 'svc/a.go'));
  check(
    "N-d with --risk <--json>: the radius rows of the chunk's files, path:line",
    cr?.callersFrom === 'risk-tier radius' &&
      cr.callers.includes('other/use.go:6 (ComputeTotal)') &&
      pr.risk.radius?.length === 2,
    JSON.stringify(cr),
  );
  const ur = pr.chunks.find((c) => c.items.some((it) => it.path === 'ui/lib.ts'));
  check(
    'N-d …a chunk the radius holds nothing for falls back to git grep',
    ur?.callersFrom?.startsWith('git grep') &&
      ur.callers.some((x) => x.startsWith('ui/page.tsx:3')),
    JSON.stringify(ur),
  );
  {
    // Go internal/: a method homonym in another module cannot be a caller (measured: another module's own GetByKey).
    const st = (v) =>
      `package store\n\ntype Store struct{}\n\nfunc (s *Store) GetByKey(k string) int {\n\treturn ${v}\n}\n`;
    const r2 = repo2(
      'fn-internal',
      {
        'mod1/internal/store/s.go': st(1),
        'mod1/svc/use.go':
          'package svc\n\nfunc Use(st *store.Store) int {\n\treturn st.GetByKey("a")\n}\n',
        'mod2/other.go':
          'package other\n\nfunc Other(r *Repo) int {\n\treturn r.GetByKey("b")\n}\n',
      },
      { 'mod1/internal/store/s.go': st(2) },
    );
    const o2 = path.join(r2.dir, '.plan');
    run('plan', '--repo', r2.dir, '--base', r2.base, '--out', o2, '--scratch', 'none');
    const c2 = JSON.parse(readFileSync(path.join(o2, 'plan.json'), 'utf8')).chunks[0];
    check(
      'N-d Go internal/: a caller inside the owning module is listed',
      c2?.callers?.includes('mod1/svc/use.go:4 (GetByKey)'),
      JSON.stringify(c2?.callers),
    );
    check(
      'N-d Go internal/: a same-named method call in another module is not',
      !c2?.callers?.some((x) => x.startsWith('mod2/')),
      JSON.stringify(c2?.callers),
    );
  }
  {
    // go.sum untracked in the checkout: the clone gets a copy beside each changed module's go.mod.
    const r3 = repo2(
      'gosum',
      {
        '.gitignore': 'go.sum\n',
        'svc/go.mod': 'module x/svc\n\ngo 1.25\n',
        'svc/a.go': 'package svc\n\nvar A = 1\n',
        'idle/go.mod': 'module x/idle\n',
      },
      { 'svc/a.go': 'package svc\n\nvar A = 2\n' },
    );
    writeFileSync(path.join(r3.dir, 'svc', 'go.sum'), 'example.com/m v1.0.0 h1:abc=\n');
    writeFileSync(path.join(r3.dir, 'idle', 'go.sum'), 'example.com/n v1.0.0 h1:def=\n');
    const o3 = path.join(r3.dir, '.plan');
    const rs = run('plan', '--repo', r3.dir, '--base', r3.base, '--out', o3, '--slug', 'gosum');
    const c3 = path.join(SCRATCH_ROOT, 'review-gosum', 'clone');
    check(
      'S go.sum: the clone of a module with changed files gets the untracked go.sum',
      existsSync(path.join(c3, 'svc', 'go.sum')) &&
        readFileSync(path.join(c3, 'svc', 'go.sum'), 'utf8').startsWith('example.com/m') &&
        /scratch: [^\n]*go\.sum copied: svc/.test(rs.stdout),
      rs.stdout + rs.stderr,
    );
    check(
      'S go.sum: a module with no changed file is left alone',
      !existsSync(path.join(c3, 'idle', 'go.sum')),
    );
    const cl = run('clean', '--scratch', c3);
    check(
      'S go.sum: clean removes the clone with the copied go.sum',
      cl.status === 0 && !existsSync(c3),
      cl.stdout + cl.stderr,
    );
  }

  // b. Sweep paths by file; every chunk path once in the prompt.
  const pathsFile = path.join(out, 'lane-A-r1.paths');
  const want = [
    ...new Set(
      p.lanes[0].rounds[0].flatMap((id) =>
        p.chunks.find((c) => c.id === id).items.map((it) => it.path),
      ),
    ),
  ];
  check(
    'N-b plan writes lane-A-r1.paths, one repo path per line, and the sweep reads it with --paths @<abs>',
    existsSync(pathsFile) &&
      readFileSync(pathsFile, 'utf8').trim().split('\n').sort().join() === want.sort().join() &&
      A.includes(`--paths "@${pathsFile.replace(/\\/g, '/')}"`),
    A.match(/review-sweep[^\n]*/)?.[0],
  );
  check(
    'N-b no inline path list: a chunk path appears once in the prompt',
    A.split('ui/lib.ts').length === 2 && A.split('svc/big.go').length === 2,
    String(A.split('ui/lib.ts').length - 1),
  );
  const rr = run(
    'prompt',
    '--plan',
    path.join(out, 'plan.json'),
    '--lane',
    'A',
    '--chunks',
    p.chunks[0].id,
    '--slug',
    'fn',
  );
  check(
    'N-b a rerun prompt writes its own lane-A-rerun-<chunk>.paths',
    rr.status === 0 &&
      existsSync(path.join(out, `lane-A-rerun-${p.chunks[0].id}.paths`)) &&
      rr.stdout.includes(`lane-A-rerun-${p.chunks[0].id}.paths`),
    rr.stderr,
  );

  // a. Fan-out protocol, g. candidate format, the owner note.
  check(
    'N-a fan-out: all independent reads per message, ≥3 while reading, a chunk opened in ONE message',
    /every message carries ALL the independent reads and searches/.test(A) &&
      /at least 3 per message/.test(A) &&
      /Opening a chunk is ONE message: its pack windows \+ the callers and enclosing code it needs \+ a Grep of each changed symbol/.test(
        A,
      ),
  );
  check(
    'N-g candidates: a `## Candidates` section, one line each in the fixed shape',
    A.includes('`## Candidates`') &&
      A.includes(
        '`- CA<n> · <repo path>:<head line>[-<end>] · <mechanism, one clause> · <🔴|🟡|🟢|❓>[ 🔵] · <high|mid|low> · <what would prove it>`',
      ) &&
      B.includes('`- CB<n> · '),
  );
  check(
    "N-g site = the head file's own line, no pack line or ~N",
    [A, B].every((t) =>
      t.includes(
        "The site is the head file's own line number, seen in your Read of that file — a pack line, `~N` or a function name is no site.",
      ),
    ),
  );
  check(
    'N probe hygiene: probe files named per lane+round and deleted before hand-back',
    A.includes('named `zz_laneA_r1_*` and deleted before you hand back') &&
      B.includes('`zz_laneB_r1_*`'),
  );
  check(
    'N passes: `## Passes` demanded with all 14 keys (review-merge composes Passes/Classes from it)',
    [A, B].every(
      (t) =>
        t.includes('`## Passes`, the last section of your file') &&
        [
          'promises (',
          'config (',
          'parse (',
          'registries (',
          'deviance (',
          'claims (',
          'history (',
          'attacker (',
          'siblings (',
          'parity (',
          'hang (',
          'before-gate (',
          'environment (',
          'contract (',
        ].every((k) => t.includes(k)) &&
        t.includes('every `## Passes` key answered'),
    ),
  );
  check(
    'N --note: an owner decision rides in every prompt',
    [A, B].every((t) =>
      t.includes(
        'Owner decision for this review (it overrides any line above it contradicts): NO rerun rounds — exactly two spawns',
      ),
    ),
  );
  const noteFile = path.join(dir, 'note.txt');
  writeFileSync(noteFile, 'Read ALL chunks; never hand back early.\n');
  const pn = run(
    'prompt',
    '--plan',
    path.join(out, 'plan.json'),
    '--lane',
    'B',
    '--note',
    `@${noteFile}`,
  );
  check(
    "N --note @file on `prompt` adds to the plan's notes",
    pn.status === 0 &&
      pn.stdout.includes('NO rerun rounds') &&
      pn.stdout.includes(
        'Owner decision for this review (it overrides any line above it contradicts): Read ALL chunks; never hand back early.',
      ),
    pn.stderr,
  );
  check(
    'N lint off → one line saying so',
    /Lint: not run at plan time — switched off \(--lint off\)/.test(A),
  );

  // g. check: a candidate line naming a path and saying «read» is no ledger row; old ledgers still pass.
  const lf = path.join(dir, 'lane-cand.md');
  const allIds = p.chunks.map((c) => c.id).join(' ');
  const rows = p.files
    .filter((f) => f !== 'ui/lib.ts')
    .map((f) => `| ${f} | read |`)
    .join('\n');
  writeFileSync(
    lf,
    `# Lane A r1 — ${allIds}\n${rows}\n## Candidates\n- CA1 · ui/lib.ts:1 · the value is read twice · 🟡 · mid · a probe with n=0\n`,
  );
  const lfB = path.join(dir, 'lane-cand-b.md');
  writeFileSync(lfB, `# Lane B r1 — ${allIds}\n`);
  const ck = run('check', '--plan', path.join(out, 'plan.json'), lf, lfB);
  check(
    'N-g check: a candidate line is never a ledger row (ui/lib.ts still owed one)',
    ck.status === 1 && /no ledger row \(1\):\n\s+ui\/lib\.ts/.test(ck.stdout),
    ck.stdout,
  );
  writeFileSync(
    lf,
    `# Lane A r1 — ${allIds}\n${rows}\n| ui/lib.ts | read |\n## Candidates\n- CA1 · ui/lib.ts:1 · the value is read twice · 🟡 · mid · a probe with n=0\n`,
  );
  const ck2 = run('check', '--plan', path.join(out, 'plan.json'), lf, lfB);
  check('N-g check: …with its row the new-format lane file passes', ck2.status === 0, ck2.stdout);

  // h. --lessons: the «Review lessons» section only, trimmed to ≈1.5k tokens.
  const prof = path.join(dir, 'profile.md');
  writeFileSync(
    prof,
    [
      '# Style profile',
      '## Fronts',
      'FRONT-SECRET',
      '## Review lessons (rules, newest first)',
      'LESSON-FIRST: a mutation must invalidate only its own keys.',
      ...Array.from(
        { length: 120 },
        (_, i) => `- lesson ${i}: ${'a reviewer missed this class of defect twice '.repeat(2)}`,
      ),
      'LESSON-END',
      '### sub heading inside lessons',
      '## Other',
      'OTHER-SECRET',
    ].join('\n'),
  );
  const pl = run(
    'plan',
    '--repo',
    dir,
    '--base',
    base,
    '--out',
    path.join(dir, '.planL'),
    '--slug',
    'fnl',
    '--lessons',
    prof,
  );
  const L = existsSync(path.join(dir, '.planL', 'lane-A-r1.prompt.md'))
    ? readFileSync(path.join(dir, '.planL', 'lane-A-r1.prompt.md'), 'utf8')
    : '';
  const lessonsPart = L.slice(L.indexOf('«Review lessons»'), L.indexOf('\nLedger:'));
  const est = (s) => (Buffer.byteLength(s, 'utf8') + 8 * s.split('\n').length) / 2.2;
  check(
    'N-h --lessons: the section embedded, trimmed, nothing from other sections',
    pl.status === 0 &&
      L.includes('LESSON-FIRST') &&
      !L.includes('LESSON-END') &&
      !L.includes('FRONT-SECRET') &&
      !L.includes('OTHER-SECRET') &&
      /trimmed — the whole section/.test(L),
    L.slice(0, 300) + pl.stderr,
  );
  check(
    'N-h …within ≈1.5k tokens',
    lessonsPart.length > 0 && est(lessonsPart) <= 1600,
    String(Math.round(est(lessonsPart))),
  );
  const noLess = path.join(dir, 'nolessons.md');
  writeFileSync(noLess, '# Profile\n## Fronts\nx\n');
  const pl2 = run(
    'plan',
    '--repo',
    dir,
    '--base',
    base,
    '--out',
    path.join(dir, '.planL2'),
    '--lessons',
    noLess,
    '--scratch',
    'none',
  );
  check(
    'N-h a profile without the section → said, nothing embedded',
    pl2.status === 0 && /lessons: no «Review lessons» heading/.test(pl2.stdout),
    pl2.stdout + pl2.stderr,
  );

  // i. Lint at plan time through a fake sweep: rows cited under their chunk, the lane sweep skips lint.
  const fake = path.join(root, 'fake-sweep.mjs');
  writeFileSync(
    fake,
    `import { writeFileSync, readFileSync } from 'node:fs'\nconst a = process.argv.slice(2)\nif (a[0] !== 'lint') process.exit(2)\nconst at = (k) => a[a.indexOf(k) + 1]\nif (!readFileSync(at('--paths').slice(1), 'utf8').includes('svc/a.go')) process.exit(3)\nwriteFileSync(at('--out'), '# semgrep: ok\\nsvc/a.go:12 · vet/shadow · declaration of total shadows\\ndocs/a.md:3 · fake/doc · x\\nnot/in/diff.go:1 · vet/x · y\\n')\n`,
  );
  const lr = runEnv(
    { REVIEW_SWEEP_TOOL: fake },
    'plan',
    '--repo',
    dir,
    '--base',
    base,
    '--out',
    path.join(dir, '.planI'),
    '--slug',
    'fni',
  );
  const pI = existsSync(path.join(dir, '.planI', 'plan.json'))
    ? JSON.parse(readFileSync(path.join(dir, '.planI', 'plan.json'), 'utf8'))
    : { chunks: [] };
  const IA = existsSync(path.join(dir, '.planI', 'lane-A-r1.prompt.md'))
    ? readFileSync(path.join(dir, '.planI', 'lane-A-r1.prompt.md'), 'utf8')
    : '';
  check(
    'N-i lint ran once at plan time into lint.txt; 2 rows in the diff',
    lr.status === 0 &&
      /lint: 2 rows → .*lint\.txt/.test(lr.stdout) &&
      existsSync(path.join(dir, '.planI', 'lint.txt')),
    lr.stdout + lr.stderr,
  );
  check(
    'N-i …each row cited under its chunk as a sweep row owing a verdict',
    /- c\d+: [^\n]*svc\/a\.go[^\n]*\n {2}lint rows \(sweep rows, each owes a verdict\): svc\/a\.go:12 · vet\/shadow · declaration of total shadows/.test(
      IA,
    ) &&
      pI.chunks.find((c) => c.items.some((it) => it.path === 'docs/a.md'))?.lint?.[0] ===
        'docs/a.md:3 · fake/doc · x',
    IA.slice(0, 1500),
  );
  check(
    "N-i …and the lane's sweep skips lint (--no-lint)",
    /review-sweep\.mjs"? all [^\n]*--no-lint/.test(IA),
    IA.match(/review-sweep[^\n]*/)?.[0],
  );
  const usage = path.join(root, 'old-sweep.mjs');
  writeFileSync(
    usage,
    `console.error('usage: review-sweep.mjs sweep|guards|renames|knobs|mutants|all --base <sha>')\nprocess.exit(2)\n`,
  );
  const lu = runEnv(
    { REVIEW_SWEEP_TOOL: usage },
    'plan',
    '--repo',
    dir,
    '--base',
    base,
    '--out',
    path.join(dir, '.planU'),
    '--slug',
    'fnu',
  );
  const UA = existsSync(path.join(dir, '.planU', 'lane-A-r1.prompt.md'))
    ? readFileSync(path.join(dir, '.planU', 'lane-A-r1.prompt.md'), 'utf8')
    : '';
  check(
    'N-i a sweep without `lint` is tolerated: one line in the prompt, the plan goes on',
    lu.status === 0 &&
      /Lint: not run at plan time — review-sweep has no `lint` subcommand yet/.test(UA) &&
      !/--no-lint/.test(UA),
    lu.stdout + lu.stderr,
  );
}

// core.quotepath: a Cyrillic changed path went into the sweep --paths octal-quoted ("QA/\320\242…") and the
// sweep matched no changed file (exit 2). The repo forces quotepath on, so a global `false` cannot hide it.
{
  const { dir, base } = repo('cyr', {
    'QA/backend/ТК-DASHBOARD-009.md': 'Шаг 1.\n',
    'svc/a.go': lines(5),
  });
  git(dir, 'config', 'core.quotepath', 'true');
  const out = path.join(dir, '.plan');
  const r = run('plan', '--repo', dir, '--base', base, '--out', out, '--slug', 'cyr');
  const p = existsSync(path.join(out, 'plan.json'))
    ? JSON.parse(readFileSync(path.join(out, 'plan.json'), 'utf8'))
    : { files: [] };
  const paths = existsSync(path.join(out, 'lane-A-r1.paths'))
    ? readFileSync(path.join(out, 'lane-A-r1.paths'), 'utf8')
    : '';
  check(
    'Q a Cyrillic path stays itself in plan.json and the sweep .paths, never octal-quoted',
    r.status === 0 &&
      p.files.includes('QA/backend/ТК-DASHBOARD-009.md') &&
      paths.split('\n').includes('QA/backend/ТК-DASHBOARD-009.md') &&
      !/\\\d{3}/.test(paths),
    `${JSON.stringify(p.files)} ${paths} ${r.stderr}`,
  );
  check(
    'Q …and its diff is in the pack',
    existsSync(path.join(out, 'pack.diff')) &&
      readFileSync(path.join(out, 'pack.diff'), 'utf8').includes('+Шаг 1.'),
  );
}

// f. Every planned lane-round in spawn waves of ≤6, prompts ready; status names the waves.
{
  const files = {};
  for (const z of ['z1', 'z2', 'z3', 'z4']) files[`${z}/a.go`] = lines(40);
  const { dir, base } = repo('waves', files);
  const out = path.join(dir, '.plan');
  const r = run(
    'plan',
    '--repo',
    dir,
    '--base',
    base,
    '--out',
    out,
    '--slug',
    'wv',
    '--per-round',
    '1',
  );
  const p = JSON.parse(readFileSync(path.join(out, 'plan.json'), 'utf8'));
  const waves = r.stdout.split('\n').filter((l) => /^wave \d+:/.test(l));
  check(
    'W plan: 4 chunks × 2 lanes, one per round → 8 lane-rounds in 2 waves',
    r.status === 0 &&
      p.laneRounds === 8 &&
      p.waves === 2 &&
      /lane-rounds 8 in 2 spawn waves of ≤6/.test(r.stdout),
    r.stdout,
  );
  check(
    'W the waves list every lane-round once, 6 then 2, r1 of both lanes first',
    waves.length === 2 &&
      waves[0].split('` ← ').length - 1 === 6 &&
      waves[1].split('` ← ').length - 1 === 2 &&
      /^wave 1: `deep-review r1 lane A` ← [^·]*lane-A-r1\.prompt\.md · `deep-review r1 lane B`/.test(
        waves[0],
      ) &&
      /r4 lane B/.test(waves[1]),
    waves.join('\n'),
  );
  check(
    'W every listed prompt and its .paths exist',
    ['A', 'B'].every((l) =>
      [1, 2, 3, 4].every(
        (k) =>
          existsSync(path.join(out, `lane-${l}-r${k}.prompt.md`)) &&
          existsSync(path.join(out, `lane-${l}-r${k}.paths`)),
      ),
    ),
  );
  const r3 = readFileSync(path.join(out, 'lane-B-r3.prompt.md'), 'utf8');
  check(
    "W a later round's prompt names its own chunks and deliverable",
    r3.includes(`# Lane B r3 — ${p.lanes[1].rounds[2].join(' ')}`) && r3.includes('lane-B-r3.md'),
    r3.slice(0, 600),
  );
  const st = run('status', '--plan', path.join(out, 'plan.json'));
  check(
    'W status with no reports: spawn all 8, in waves',
    st.status === 0 &&
      /next: spawn all 8 planned lane-rounds/.test(st.stdout) &&
      /wave 2: /.test(st.stdout),
    st.stdout,
  );
  writeFileSync(
    path.join(dir, 'la.md'),
    `# Lane A r1 — ${p.lanes[0].rounds[0][0]}\n| z1/a.go | read |\n`,
  );
  const ck = run('check', '--plan', path.join(out, 'plan.json'), path.join(dir, 'la.md'));
  check(
    'W check still lists RERUN lines for the unfinished chunks only',
    ck.status === 1 &&
      /RERUN lane A: (?!.*z1)/.test(ck.stdout) &&
      !new RegExp(`RERUN lane A: [^\\n]*${p.lanes[0].rounds[0][0]}\\b`).test(ck.stdout) &&
      /RERUN lane B/.test(ck.stdout),
    ck.stdout,
  );
}

// Fold: a round that fits whole into another's headroom joins it — greedy in path order left a 3k tail round
// (bench mr-bdfb4d6 re-plan). Zones a/ b/ c/ = one chunk each, sized 100/115/30 lines; the round cap admits
// b alone and a+c, but neither a+b nor b+c, so greedy makes 3 rounds per lane and fold makes 2.
{
  const { dir, base } = repo('fold', {
    'a/x.go': lines(100),
    'b/x.go': lines(115),
    'c/x.go': lines(30),
  });
  const big = path.join(dir, '.p-big');
  run(
    'plan',
    '--repo',
    dir,
    '--base',
    base,
    '--out',
    big,
    '--scratch',
    'none',
    '--round-tokens',
    '999999',
  );
  const pb = JSON.parse(readFileSync(path.join(big, 'plan.json'), 'utf8'));
  const tok = (z) => pb.chunks.find((c) => c.zone === z).tokens;
  const cap = tok('a') + tok('c') + 1;
  const out = path.join(dir, '.p-fold');
  const r = run(
    'plan',
    '--repo',
    dir,
    '--base',
    base,
    '--out',
    out,
    '--scratch',
    'none',
    '--round-tokens',
    String(cap),
  );
  const pf = r.status === 0 ? JSON.parse(readFileSync(path.join(out, 'plan.json'), 'utf8')) : null;
  const zoneSets = (l) =>
    l.rounds
      .map((rd) =>
        rd
          .map((id) => pf.chunks.find((c) => c.id === id).zone)
          .sort()
          .join('+'),
      )
      .sort();
  check(
    'fold: setup — b and a+c fit the cap, a+b and b+c exceed it',
    pb.chunks.length === 3 &&
      tok('b') <= cap &&
      tok('a') + tok('b') > cap &&
      tok('b') + tok('c') > cap,
    JSON.stringify(pb.chunks.map((c) => [c.zone, c.tokens])),
  );
  check(
    'fold: the c tail joins a, 2 rounds per lane, each under the cap',
    pf &&
      pf.lanes.every(
        (l) =>
          JSON.stringify(zoneSets(l)) === JSON.stringify(['a+c', 'b']) &&
          l.roundTokens.every((t) => t <= cap),
      ) &&
      pf.laneRounds === 4,
    JSON.stringify(pf?.lanes.map((l) => [l.id, zoneSets(l), l.roundTokens])),
  );
}

// A pathspec past the Windows command-line cap (32,767 chars): `git diff -- <all code files>` in callers()
// returned no stdout and git() crashed on `r.stderr.trim()` (a 1494-file diff).
{
  const { pathBatches } = await import(
    pathToFileURL(path.join(path.dirname(TOOL), 'lib', 'argv.mjs')).href
  );
  const bs = pathBatches(['aaaa', 'bb', 'cccc', 'd'], 8);
  check(
    'pathBatches: order kept, each batch within budget',
    JSON.stringify(bs) ===
      JSON.stringify([
        ['aaaa', 'bb'],
        ['cccc', 'd'],
      ]),
    JSON.stringify(bs),
  );
  check(
    'pathBatches: [] → one empty batch; an over-budget path gets its own batch',
    JSON.stringify(pathBatches([], 8)) === '[[]]' &&
      JSON.stringify(pathBatches(['x'.repeat(20), 'y'], 8)) ===
        JSON.stringify([['x'.repeat(20)], ['y']]),
  );
  const dirName = 'd'.repeat(90);
  const names = Array.from({ length: 400 }, (_, i) => `pkg/${dirName}/f${i}.ts`);
  const dir = path.join(root, 'long-pathspec');
  mkdirSync(dir, { recursive: true });
  git(dir, 'init', '-q');
  git(dir, 'config', 'user.email', 't@t');
  git(dir, 'config', 'user.name', 't');
  const put = (v) => {
    for (const [i, n] of names.entries()) {
      mkdirSync(path.dirname(path.join(dir, n)), { recursive: true });
      writeFileSync(path.join(dir, n), `export const v${i} = ${v}\n`);
    }
  };
  put(1);
  git(dir, 'add', '-A');
  git(dir, 'commit', '-qm', 'base');
  const base = git(dir, 'rev-parse', 'HEAD');
  put(2);
  git(dir, 'add', '-A');
  git(dir, 'commit', '-qm', 'head');
  const out = path.join(dir, '.plan');
  const r = run('plan', '--repo', dir, '--base', base, '--out', out, '--scratch', 'none');
  const p = r.status === 0 ? JSON.parse(readFileSync(path.join(out, 'plan.json'), 'utf8')) : null;
  check(
    'long pathspec (400 code files, >40k chars): plan runs and lists every file',
    r.status === 0 && p.files.length === 400,
    (r.stderr || '').slice(0, 400),
  );
}

console.log(`\n${pass} passed, ${fails.length} failed`);
if (fails.length) {
  for (const f of fails) console.log('  - ' + f);
  process.exit(1);
}
