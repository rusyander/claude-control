// review-publish: an assembled deep-review report → forge-ready cards. What is pinned: every thread card
// passes review-publish-guard's card shape (its CARD regexes, copied here and checked against the guard
// source so a drift fails this test) and its `**Where:**` equals the position it ships with; a `*` inside a
// code span never breaks the bold; a clause never ends inside a citation; Status/Axis/Thread/Synced fields
// leave the card; «same as F-NN» folds; a site outside the diff is re-anchored to a shown place or goes
// to the summary note; scaffolding is scrubbed where safe and flagged (exit 4) where a sentence must change.
// Run: node review-publish.selftest.mjs   (REVIEW_PUBLISH_TOOL=<copy> runs a mutant; the guard is read from
// <tool dir>/../hooks/lib/review-publish-guard.mjs unless REVIEW_PUBLISH_GUARD names it)
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const TOOL = process.env.REVIEW_PUBLISH_TOOL || path.join(HERE, '..', 'review-publish.mjs');
const P = await import(pathToFileURL(TOOL).href);
const GUARD =
  process.env.REVIEW_PUBLISH_GUARD ||
  path.join(path.dirname(TOOL), '..', 'hooks', 'lib', 'review-publish-guard.mjs');
const GUARD_SRC = readFileSync(GUARD, 'utf8');

let pass = 0;
const fails = [];
const check = (name, ok, detail = '') => {
  if (ok) pass++;
  else fails.push(name);
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${name}${ok || !detail ? '' : ' — ' + detail}`);
};
const root = mkdtempSync(path.join(os.tmpdir(), 'review-publish-'));
process.on('exit', () => rmSync(root, { recursive: true, force: true }));

// The guard's card shape, verbatim; the source check below fails when the guard changes it.
const CARD_SRC = [
  String.raw`[/^\s*(?:🔴|🟡|❓|🟢)/u, 'severity marker first (🔴/🟡/❓/🟢)']`,
  String.raw`[/(?<![\w-])F-\d+/, 'id ` + '`F-NN`' + `']`,
  String.raw`[/^[^\n]*\*\*[^*\n]+\*\*/, 'bold one-line thesis on the first line']`,
];
const CARD = [
  /^\s*(?:🔴|🟡|❓|🟢)/u,
  /(?<![\w-])F-\d+/,
  /^[^\n]*\*\*[^*\n]+\*\*/,
  /\*\*Where:\*\*\s*`?[^\s`]+:\d+(?:-\d+)?/,
];
check(
  'guard source still carries the card regexes this test mirrors',
  CARD_SRC.every((s) => GUARD_SRC.includes(s)),
);
check(
  'guard accepts the `**Where:**` field the cards carry',
  /\(\?:[^)]*\bWhere\b/.test(GUARD_SRC),
);
const cardOk = (b) => CARD.every((re) => re.test(b));

// ---- pure helpers --------------------------------------------------------------------------------------
check(
  'clause: ends at `: ` outside parentheses and quotes',
  P.clause('The header (x.mjs:94-95: «a (b)»), and the rule: further')[0] ===
    'The header (x.mjs:94-95: «a (b)»), and the rule',
);
check(
  'clause: a `: ` inside a code span is code',
  P.clause('flag `a: b` breaks parsing')[1] === '',
);
check(
  'clause sentence: ends at `. ` past the opening words',
  P.clause('The cap test takes 70 and 60 pushes. The MR cap is not checked', {
    sentence: true,
  })[1] === 'The MR cap is not checked',
);
const b1 = P.boldHead('The alias from `GIT_CONFIG_*` is chosen wrongly');
check(
  'boldHead: a `*` inside code ends the bold before the span, the code stays intact',
  /^\*\*The alias from\*\* `GIT_CONFIG_\*` is chosen/.test(b1) && CARD[2].test(b1),
  b1,
);
check(
  'boldHead: emphasis outside code is dropped',
  P.boldHead('a *b* **c**') === '**a b c**',
  P.boldHead('a *b* **c**'),
);
check(
  'boldHead: a `*` span at the start → a `**Finding:**` head',
  /^\*\*Finding:\*\* `X_\*`/.test(P.boldHead('`X_*` breaks')),
);
const pl = P.placesOf('`scripts/s.mjs:10-20` (other sites: `:30`, `b/x.go:7`)');
const pc = P.placesOf('`a/s.go:701,711-712` (other sites: `b/c.yaml:5`, `:9,12`)');
check(
  'placesOf: a comma list is one place per item, main = the first, in the parenthetical too',
  pc.map((x) => `${x.file}:${x.from}-${x.to}`).join(' ') ===
    'a/s.go:701-701 a/s.go:711-712 b/c.yaml:5-5 a/s.go:9-9 a/s.go:12-12' &&
    pc[0].text === 'a/s.go:701,711-712',
  JSON.stringify(pc),
);
check(
  'placesOf: main range, bare :N of the same file, a path:line',
  pl.map((x) => `${x.file}:${x.from}-${x.to}`).join(' ') ===
    'scripts/s.mjs:10-20 scripts/s.mjs:30-30 b/x.go:7-7',
  JSON.stringify(pl),
);

// ---- a repo with a diff, a report, prepare + index -----------------------------------------------------
const repo = path.join(root, 'repo');
mkdirSync(path.join(repo, 'src'), { recursive: true });
const g = (...a) => spawnSync('git', ['-C', repo, ...a], { encoding: 'utf8' });
g('init', '-q');
g('config', 'user.email', 't@t');
g('config', 'user.name', 't');
const lines = Array.from({ length: 100 }, (_, i) => `const v${i + 1} = ${i + 1}`);
writeFileSync(path.join(repo, 'src/a.mjs'), lines.join('\n') + '\n');
g('add', '.');
g('commit', '-qm', 'base');
const base = g('rev-parse', 'HEAD').stdout.trim();
lines[49] = 'const v50 = 5000'; // line 50 changed: shown 47..53
writeFileSync(path.join(repo, 'src/a.mjs'), lines.join('\n') + '\n');
g('commit', '-qam', 'head');
const head = g('rev-parse', 'HEAD').stdout.trim();

const report = path.join(root, 'r.agent.md');
writeFileSync(
  report,
  [
    '# Review: test',
    '**Verified:** `node --test` at head; probe `zz_laneA_r1_x.mjs` in the clone',
    '',
    '## Verdict on the stated',
    '',
    'The stated change is done.',
    '',
    '## Findings',
    '',
    '### F-01 🟡🔵 The value `v50` breaks `X_*` and the total',
    '',
    '- **Where:** `src/a.mjs:50`',
    '- **Thread:** https://forge.example.com/x/-/merge_requests/1#note_1',
    '- **Synced:** 2026-11-03 — thread open',
    '- **Axis:** correctness',
    '- **Evidence (L1 — run):** probe in a container `--rm --label claude.ephemeral=1`:',
    '  ```',
    '  v50 → 5000',
    '  ```',
    '- **Fix:** set it back to 50.',
    '- **Status:** open',
    '',
    '### F-02 🟡 Root outside the diff',
    '',
    '- **Where:** `src/a.mjs:10-12` (other sites: `:48-60`)',
    '- **Evidence (L0 — quote):** I read the line `src/a.mjs:10`.',
    '- **Status:** open',
    '',
    '### F-03 🟡 same as F-01: the same shape through `v50`',
    '',
    '- **Where:** `src/a.mjs:50`',
    '- **Status:** open',
    '',
    '### F-04 ❓ Entirely outside the diff',
    '',
    '- **Where:** `src/a.mjs:90`',
    '- **Status:** open',
    '',
    '### F-06 🟡 A comma list of lines',
    '',
    '- **Where:** `src/a.mjs:10,50`',
    '- **Status:** open',
    '',
    '## Done well',
    '',
    '- A clean edit.',
    '',
    '## Nits',
    '',
    '- F-05 🟢 the test does not check (x.mjs:1: «a: b») the boundary. Second sentence — **Where:** `src/a.mjs:51` · **Axis:** style · **Status:** open',
    '- **Thread:** https://forge.example.com/x/-/merge_requests/1#note_5',
    '',
  ].join('\n'),
);
const out = path.join(root, 'pub');
const r = spawnSync(
  process.execPath,
  [
    TOOL,
    'prepare',
    '--report',
    report,
    '--out',
    out,
    '--repo',
    repo,
    '--base-sha',
    base,
    '--head-sha',
    head,
  ],
  { encoding: 'utf8' },
);
const man = existsSync(path.join(out, 'manifest.json'))
  ? JSON.parse(readFileSync(path.join(out, 'manifest.json'), 'utf8')).cards
  : [];
const by = (id) => man.find((m) => m.id === id);
const body = (id) =>
  existsSync(path.join(out, `${id}.md`)) ? readFileSync(path.join(out, `${id}.md`), 'utf8') : '';
const pos = (id) =>
  existsSync(path.join(out, `${id}.pos.json`))
    ? JSON.parse(readFileSync(path.join(out, `${id}.pos.json`), 'utf8')).position
    : null;
check(
  'prepare: exit 4 while flags remain (first person «I», a rung label left)',
  r.status === 4 && /FLAGS/.test(r.stdout) && /F-02\.md:\d+ first person/.test(r.stdout),
  r.stdout + r.stderr,
);
const threads = man.filter((m) => m.kind === 'thread');
check(
  'F-06 comma list: the first shown item anchors, `**Where:**` names it, the list follows',
  by('F-06')?.reanchored &&
    pos('F-06')?.new_line === 50 &&
    /\*\*Where:\*\* `src\/a\.mjs:50(-50)?` \(other sites: `src\/a\.mjs:10,50`/.test(body('F-06')),
  body('F-06').split('\n')[2],
);
check(
  'every thread card passes the guard card shape',
  threads.length === 4 && threads.every((m) => cardOk(body(m.id))),
  threads.map((m) => `${m.id}:${cardOk(body(m.id))}`).join(' '),
);
check(
  'every thread anchor equals its card `**Where:**`',
  threads.every((m) => {
    const loc = body(m.id).match(/\*\*Where:\*\*\s*`?([^\s`]+?):(\d+)(?:-(\d+))?/);
    const p = pos(m.id);
    return (
      loc &&
      p &&
      p.new_line === +(loc[3] ?? loc[2]) &&
      (!p.line_range || p.line_range.start.new_line === +loc[2])
    );
  }),
  threads.map((m) => JSON.stringify(pos(m.id)?.new_line)).join(' '),
);
check(
  'F-01 head: severity + 🔵, label, id, bold ending before the `*` code span',
  body('F-01').startsWith('🟡🔵 before merge F-01 **The value `v50` breaks** `X_*` and the total'),
  body('F-01').split('\n')[0],
);
check(
  'F-01: Thread / Synced / Axis / Status fields left the card',
  !/\*\*(Thread|Synced|Axis|Status):\*\*/.test(body('F-01')) &&
    /```\n\s*v50 → 5000/.test(body('F-01')),
  body('F-01'),
);
check(
  'F-01: rung label and container label scrubbed',
  /\*\*Evidence \(run\):\*\*/.test(body('F-01')) && !/claude\.ephemeral|L1/.test(body('F-01')),
  body('F-01'),
);
check(
  'F-03 folded into F-01, its thesis carried over',
  by('F-03')?.kind === 'folded' &&
    by('F-03').foldedInto === 'F-01' &&
    /\*\*Same defect in another form:\*\* the same shape through `v50`/.test(body('F-01')) &&
    !existsSync(path.join(out, 'F-03.md')),
);
check(
  'F-02 re-anchored to the shown part of «other sites», the original named',
  by('F-02')?.kind === 'thread' &&
    by('F-02').reanchored &&
    /\*\*Where:\*\* `src\/a\.mjs:48-53` \(other sites: `src\/a\.mjs:10-12`/.test(body('F-02')),
  body('F-02').split('\n')[2],
);
check(
  'F-04 has no shown place → outside, no position',
  by('F-04')?.kind === 'outside' &&
    !existsSync(path.join(out, 'F-04.pos.json')) &&
    by('F-04').site === 'src/a.mjs:90',
);
check(
  'F-05 nit: bold clause ends at the sentence, not inside the «quote»; rest follows',
  body('F-05').startsWith(
    '🟢 nit F-05 **The test does not check (x.mjs:1: «a: b») the boundary.**',
  ) && /\nSecond sentence/.test(body('F-05')),
  body('F-05'),
);
check(
  'F-05 nit: its thread taken from the line after it',
  by('F-05')?.thread === 'https://forge.example.com/x/-/merge_requests/1#note_5',
);

const idx = path.join(root, 'index.md');
const ri = spawnSync(
  process.execPath,
  [TOOL, 'index', '--report', report, '--out', idx, '--manifest', path.join(out, 'manifest.json')],
  { encoding: 'utf8' },
);
const it = existsSync(idx) ? readFileSync(idx, 'utf8') : '';
check(
  'index: heading the guard reads as a summary, counts by severity',
  /^## Review: summary/.test(it) && /🔴 0 · 🟡 3 · ❓ 1 · 🟢 1 — no blocking/.test(it),
  it.slice(0, 300),
);
check(
  'index: verdict and praise carried, outside and re-anchored sites listed',
  /The stated change is done/.test(it) &&
    /A clean edit/.test(it) &&
    /F-04 — `src\/a\.mjs:90`/.test(it) &&
    /F-02 — root outside the shown lines/.test(it),
  it,
);
check(
  'index: findings linked to their thread URLs; one without a thread says so',
  /\(https:\/\/forge\.example\.com\/x\/-\/merge_requests\/1#note_1\)/.test(it) &&
    /F-02 Root outside the diff \(no thread in the report/.test(it),
  it,
);
check('index: the folded F-03 is not listed', !/F-03/.test(it));
check(
  'index: scaffolding in «What was checked» flagged, exit 4',
  ri.status === 4 && /index\.md:\d+ (probe file name|«clone»)/.test(ri.stdout),
  ri.stdout,
);
const clean = spawnSync(process.execPath, [TOOL, 'nope'], { encoding: 'utf8' });
check(
  'unknown command → usage, exit 2',
  clean.status === 2 && /usage: review-publish/.test(clean.stderr),
  clean.stderr,
);

console.log(`\n${pass} passed, ${fails.length} failed`);
if (fails.length) process.exitCode = 1;
