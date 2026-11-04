// review-bench: seeded-defect recall benchmark for deep-review. Pinned here: each mutation operator (what
// it changes AND what it must leave alone — a seed the compiler catches, or one on a test/generated file,
// measures nothing), the selection limits, the plumbing-only seeded commit (no checkout, no branch moved),
// the ±3-line candidate matcher and the per-message-id cost sum.
// Run: node review-bench.selftest.mjs (REVIEW_BENCH_TOOL = the tool under test; default the built-in kit)
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const TOOL =
  process.env.REVIEW_BENCH_TOOL ||
  path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    '../../../../../assets/kit/agentdeck-kit/tools/review-bench.mjs',
  );
const m = await import(pathToFileURL(TOOL).href);
let pass = 0;
const fails = [];
const check = (name, ok, detail = '') => {
  if (ok) pass++;
  else fails.push(`${name}${detail ? ': ' + detail : ''}`);
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${name}`);
};
const root = mkdtempSync(path.join(os.tmpdir(), 'review-bench-'));
process.on('exit', () => rmSync(root, { recursive: true, force: true }));

/** Candidates of one line given its preceding context lines. */
const cands = (file, kind, lines) => m.candidatesFor(file, kind, lines.join('\n'), [lines.length]);
const one = (file, kind, lines, op) => cands(file, kind, lines).filter((c) => c.op === op);

// 1. Go operators.
{
  check(
    'go boundary: > becomes >= in an if',
    one('a.go', 'go', ['\tif n > max {'], 'boundary')[0]?.after === '\tif n >= max {',
  );
  check(
    'go boundary: < becomes <= in a for',
    one('a.go', 'go', ['\tfor i := 0; i < n; i++ {'], 'boundary')[0]?.after ===
      '\tfor i := 0; i < n; i++ {'.replace(' < ', ' <= '),
  );
  check(
    'go boundary: a comparison outside if/for is left alone',
    one('a.go', 'go', ['\tok := a < b'], 'boundary').length === 0,
  );
  check(
    'go boundary: a channel receive is not a comparison',
    one('a.go', 'go', ['\tif v := <-ch; v {'], 'boundary').length === 0,
  );
  check(
    'go eq-swap: == becomes != in an if',
    one('a.go', 'go', ['\tif tz == "" {'], 'eq-swap')[0]?.after === '\tif tz != "" {',
  );
  check(
    'go eq-swap: an err != nil line is never touched',
    one('a.go', 'go', ['\tif err != nil {'], 'eq-swap').length === 0,
  );
  check(
    'go eq-swap: == outside an if is left alone',
    one('a.go', 'go', ['\tsame := a == b'], 'eq-swap').length === 0,
  );
  const fn = [
    'func f() (int, error) {',
    '\tx, err := g()',
    '\tif err != nil {',
    '\t\treturn 0, err',
  ];
  check(
    'swallow-err: return …, err inside if err != nil → nil',
    one('a.go', 'go', fn, 'swallow-err')[0]?.after === '\t\treturn 0, nil',
  );
  check(
    'swallow-err: the same return under another condition is left alone',
    one('a.go', 'go', ['\tif x != nil {', '\t\treturn 0, err'], 'swallow-err').length === 0,
  );
  check(
    'swallow-err: if err := h(); err != nil { return err } → return nil',
    one('a.go', 'go', ['\tif err := h(); err != nil {', '\t\treturn err'], 'swallow-err')[0]
      ?.after === '\t\treturn nil',
  );
  check(
    'swallow-err: a wrapped error is not this operator',
    one('a.go', 'go', ['\tif err != nil {', '\t\treturn fmt.Errorf("x: %w", err)'], 'swallow-err')
      .length === 0,
  );
  check(
    'client-error-5xx: StatusNotFound → StatusInternalServerError',
    one('a.go', 'go', ['\tw.WriteHeader(http.StatusNotFound)'], 'client-error-5xx')[0]?.after ===
      '\tw.WriteHeader(http.StatusInternalServerError)',
  );
  check(
    'client-error-5xx: StatusOK is left alone',
    one('a.go', 'go', ['\tw.WriteHeader(http.StatusOK)'], 'client-error-5xx').length === 0,
  );
  check(
    'drop-sql-filter: AND tenant_id = $2 line is dropped',
    one('a.go', 'go', ['\t\tAND tenant_id = $2'], 'drop-sql-filter')[0]?.drop === true,
  );
  check(
    'drop-sql-filter: a WHERE line is never dropped (SQL would break)',
    one('a.go', 'go', ['\t\tWHERE tenant_id = $1'], 'drop-sql-filter').length === 0,
  );
  check(
    'drop-sql-filter: AND deleted_at IS NULL in .sql is dropped',
    one('q.sql', 'sql', ['  AND deleted_at IS NULL'], 'drop-sql-filter')[0]?.drop === true,
  );
  check(
    'drop-defer: defer rows.Close() is dropped',
    one('a.go', 'go', ['\tdefer rows.Close()'], 'drop-defer')[0]?.drop === true,
  );
  check(
    'drop-defer: a deferred closure is left alone',
    one('a.go', 'go', ['\tdefer func() { rows.Close() }()'], 'drop-defer').length === 0,
  );
  check('go comment lines get no seed', cands('a.go', 'go', ['\t// if a > b {']).length === 0);
}

// 2. TS / Python operators.
{
  check(
    'ts boundary: <= becomes < in an if',
    one('a.ts', 'ts', ['  if (a <= b) {'], 'boundary')[0]?.after === '  if (a < b) {',
  );
  check(
    'ts boundary: an arrow is not a comparison',
    one('a.ts', 'ts', ['  if (xs.some((x) => x)) {'], 'boundary').length === 0,
  );
  check(
    'ts eq-swap: === becomes !==',
    one('a.ts', 'ts', ['const ok = a === b;'], 'eq-swap')[0]?.after === 'const ok = a !== b;',
  );
  check(
    'ts nullish-or: ?? becomes ||',
    one('a.ts', 'ts', ['const v = a ?? b;'], 'nullish-or')[0]?.after === 'const v = a || b;',
  );
  check(
    'ts nullish-or: ??= is left alone',
    one('a.ts', 'ts', ['a ??= b;'], 'nullish-or').length === 0,
  );
  check(
    'ts drop-await: an awaited expression statement loses await',
    one('a.ts', 'ts', ['async function f() {', '  await save(x);'], 'drop-await')[0]?.after ===
      '  save(x);',
  );
  check(
    'ts drop-await: an awaited assignment is left alone',
    one('a.ts', 'ts', ['async function f() {', '  const r = await f();'], 'drop-await').length ===
      0,
  );
  check(
    'ts drop-await: a continuation line is left alone',
    one('a.ts', 'ts', ['  const r =', '    await f();'], 'drop-await').length === 0,
  );
  check(
    'py is-none-swap: is None → is not None',
    one('a.py', 'py', ['    if x is None:'], 'is-none-swap')[0]?.after === '    if x is not None:',
  );
  check(
    'py is-none-swap: is not None → is None',
    one('a.py', 'py', ['    if x is not None:'], 'is-none-swap')[0]?.after === '    if x is None:',
  );
  check(
    'py eq-swap: == → !=',
    one('a.py', 'py', ['    if a == b:'], 'eq-swap')[0]?.after === '    if a != b:',
  );
  check(
    'py boundary: > → >= in an if',
    one('a.py', 'py', ['    if a > b:'], 'boundary')[0]?.after === '    if a >= b:',
  );
  check(
    'py drop-await: expression statement',
    one('a.py', 'py', ['async def f():', '    await client.close()'], 'drop-await')[0]?.after ===
      '    client.close()',
  );
  check(
    'py drop-await: assignment is left alone',
    one('a.py', 'py', ['async def f():', '    r = await g()'], 'drop-await').length === 0,
  );
}

// 3. Docs and contract numbers.
{
  check(
    'doc-number: a limit in prose changes',
    m.docNumber('Строка длиннее 64 символов — 400.') === 'Строка длиннее 128 символов — 400.',
    m.docNumber('Строка длиннее 64 символов — 400.'),
  );
  check(
    'doc-number: a small duration changes by one',
    m.docNumber('Retry after 5 seconds.') === 'Retry after 6 seconds.',
  );
  check(
    'doc-number: a date is not a quantity',
    m.docNumber('Since 2026-10-25 the report changed.') === null,
  );
  check(
    'doc-number: RFC 6585 is not a quantity, the next number is',
    m.docNumber('RFC 6585 requests over 100 requests per minute get 429') ===
      'RFC 6585 requests over 200 requests per minute get 429',
  );
  check(
    'doc-number: a ticket key is not a quantity',
    m.docNumber('See PROJ-1966 for details.') === null,
  );
  check(
    'doc-number: a number inside inline code is left alone',
    m.docNumber('Set `limit: 64 символов` there.') === null,
  );
  check(
    'doc-number: a number without unit or limit word is left alone',
    m.docNumber('Step 3 of the wizard.') === null,
  );
  check(
    'doc-number: an HTTP status before a code name is left alone',
    m.docNumber('Answers 400 BAD_REQUEST up to 3 times.') ===
      'Answers 400 BAD_REQUEST up to 4 times.',
  );
  const doc = [
    '---',
    'title: limit 64 символов',
    '---',
    'Text up to 10 requests.',
    '```',
    'limit up to 10 requests',
    '```',
  ];
  const dc = m.candidatesFor('docs/a.md', 'doc', doc.join('\n'), [2, 4, 6]);
  check(
    'doc-number: frontmatter and fenced code get no seed, prose does',
    dc.length === 1 && dc[0].headLine === 4 && dc[0].after === 'Text up to 20 requests.',
    JSON.stringify(dc.map((c) => c.headLine)),
  );
  check(
    'doc-number: a markdown bullet is prose, not a comment',
    m.candidatesFor('docs/a.md', 'doc', '* up to 10 requests', [1]).length === 1,
  );
  check(
    'contract-number: maxLength: 64 → 128',
    one('c.yaml', 'contract', ['          maxLength: 64'], 'contract-number')[0]?.after ===
      '          maxLength: 128',
  );
  check(
    'contract-number: inside a flow mapping',
    one(
      'c.yaml',
      'contract',
      ['      schema: { type: string, maxLength: 64, example: X }'],
      'contract-number',
    )[0]?.after === '      schema: { type: string, maxLength: 128, example: X }',
  );
  check(
    'contract-number: minimum: 1 → 2',
    one('c.yaml', 'contract', ['  minimum: 1'], 'contract-number')[0]?.after === '  minimum: 2',
  );
  check(
    'contract-number: example is not a constraint',
    one('c.yaml', 'contract', ['  example: 64'], 'contract-number').length === 0,
  );
}

// 4. Eligibility.
{
  const k = (f, t) => m.kindOf(f, t);
  check('kindOf: _test.go is never seeded', k('svc/a_test.go') === null);
  check('kindOf: *.test.tsx is never seeded', k('ui/src/A.test.tsx') === null);
  check(
    'kindOf: QA/ and tests/ are never seeded',
    k('QA/auto/x.py') === null && k('svc/tests/x.py') === null,
  );
  check(
    'kindOf: sqlc output is never seeded',
    k('svc/internal/store/sqlcdb/usage.sql.go') === null,
  );
  check('kindOf: *.gen.* is never seeded', k('ui/src/api.gen.ts') === null);
  check(
    'kindOf: a generated header excludes the file',
    k('docs/api/x.mdx', '---\n# Файл собран автоматически: scripts/gen.mjs\n') === null &&
      k('svc/x.go', '// Code generated by sqlc. DO NOT EDIT.\npackage x') === null,
  );
  check(
    'kindOf: fixtures are never seeded',
    k('svc/testdata/a.go') === null && k('ui/fixtures/a.ts') === null,
  );
  check(
    'kindOf: go / ts / py / sql kinds',
    k('svc/a.go') === 'go' &&
      k('ui/a.tsx') === 'ts' &&
      k('svc/a.py') === 'py' &&
      k('svc/q.sql') === 'sql',
  );
  check(
    'kindOf: md only under docs, mdx anywhere',
    k('docs/a.md') === 'doc' && k('README.md') === null && k('web-docs/content/ru/a.mdx') === 'doc',
  );
  check(
    'kindOf: yaml only as a contract',
    k('contracts/openapi/a.yaml') === 'contract' && k('helm/values.yaml') === null,
  );
}

// 5. Diff parsing, selection, application.
{
  const diff = [
    'diff --git a/x.go b/x.go',
    '--- a/x.go',
    '+++ b/x.go',
    '@@ -3,0 +4,2 @@ func',
    '+a',
    '+b',
    '@@ -10 +12 @@',
    '-old',
    '+new',
    'diff --git a/gone.go b/gone.go',
    '--- a/gone.go',
    '+++ /dev/null',
    '@@ -1 +0,0 @@',
    '-x',
  ].join('\n');
  const a = m.addedLines(diff);
  check(
    'addedLines: head-side numbers per file, deleted files absent',
    JSON.stringify([...a]) === JSON.stringify([['x.go', [4, 5, 12]]]),
    JSON.stringify([...a]),
  );
  const many = Array.from({ length: 30 }, (_, i) => ({
    file: 'a.go',
    headLine: i + 1,
    op: 'eq-swap',
  }));
  const other = [
    { file: 'b.go', headLine: 5, op: 'boundary' },
    { file: 'c.mdx', headLine: 9, op: 'doc-number' },
  ];
  const p = m.pickSeeds([...many, ...other], 10, m.rng32(1));
  check(
    'pickSeeds: at most 2 per file',
    p.filter((x) => x.file === 'a.go').length === 2,
    JSON.stringify(p),
  );
  const pa = p.filter((x) => x.file === 'a.go');
  check(
    'pickSeeds: two seeds of one file ≥ 7 lines apart',
    Math.abs(pa[0].headLine - pa[1].headLine) >= 7,
  );
  check(
    'pickSeeds: spread — every file and operator used before a second seed',
    new Set(p.map((x) => x.file)).size === 3,
  );
  check(
    'pickSeeds: same --rng → same seeds',
    JSON.stringify(m.pickSeeds([...many, ...other], 10, m.rng32(7))) ===
      JSON.stringify(m.pickSeeds([...many, ...other], 10, m.rng32(7))),
  );
  const vetoed = m.pickSeeds(other, 2, m.rng32(1), (c) => c.file !== 'b.go');
  check(
    'pickSeeds: a vetoed candidate (build broke) is replaced, never kept',
    vetoed.length === 1 && vetoed[0].file === 'c.mdx',
  );
  const text = ['l1', 'defer x.Close()', 'l3', 'l4', 'if a == b {', 'l6'].join('\n');
  const r = m.applySeeds(text, [
    { headLine: 2, drop: true },
    { headLine: 5, after: 'if a != b {' },
  ]);
  check(
    'applySeeds: a dropped line shifts later seeds up by one',
    r.placed.find((x) => x.headLine === 5).line === 4 && r.text.split('\n')[3] === 'if a != b {',
  );
  check(
    'applySeeds: a dropped seed points at the line that took its place',
    r.placed.find((x) => x.headLine === 2).line === 2 && r.text.split('\n')[1] === 'l3',
  );
}

// 6. Matcher.
{
  const truth = [
    { id: 'S01', file: 'svc/internal/store/usage.go', line: 100, class: 'logic-inversion' },
  ];
  const at = (line) =>
    m.matchTruth(
      truth,
      m.parseCandidates(`- CA1 · svc/internal/store/usage.go:${line} · inverted · 🔴 · high · run`),
    )[0].caught;
  check('match: +3 lines is caught', at(103));
  check('match: +4 lines is missed', !at(104));
  check('match: −3 lines is caught, −4 missed', at(97) && !at(96));
  check(
    'match: a range covering the line is caught',
    m.matchTruth(truth, m.parseCandidates('- CB2 · usage.go:90-110 · x · 🟡 · mid · read'))[0]
      .caught,
  );
  check(
    'match: a path suffix on a segment boundary only',
    !m.matchTruth(truth, m.parseCandidates('- CB2 · age.go:100 · x · 🟡 · mid · read'))[0].caught,
  );
  check(
    'match: an absolute path ending in the file is caught',
    m.matchTruth(
      truth,
      m.parseCandidates(
        '- CB3 · C:/work/repo/svc/internal/store/usage.go:101 · x · 🟡 · mid · read',
      ),
    )[0].caught,
  );
  check(
    'match: a ledger row (starts with |) is not a candidate',
    m.parseCandidates('| svc/internal/store/usage.go:100 | read · swept |').length === 0,
  );
  check(
    'match: a clean cell is not a candidate',
    m.parseCandidates('- usage.go:100 · clean — usage.go:100').length === 0,
  );
  check(
    'match: a legacy candidate line counts',
    m.matchTruth(
      truth,
      m.parseCandidates(
        '- `svc/internal/store/usage.go:99` · loc check inverted · 🔴 guess · high · test with tz',
      ),
    )[0].caught,
  );
  check(
    'match: a line without · is not a candidate',
    m.parseCandidates('see usage.go:100 for details').length === 0,
  );
  check(
    'match: a new-format line cites its site field only, not the proof field',
    !m.matchTruth(
      truth,
      m.parseCandidates(
        '- CA4 · other.go:5 · x · 🟡 · mid · compare svc/internal/store/usage.go:100',
      ),
    )[0].caught,
  );
}

// 7. Tools rewrite and fidelity patch.
{
  const home = 'C:\\Users\\me';
  const t =
    'node ~/.claude/tools/review-sweep.mjs · C:\\Users\\me\\.claude\\tools\\x.mjs · /c/Users/me/.claude/tools/y.mjs · C:/Users/me/.claude/tools-baseline/z.mjs';
  const live = 'C:/Users/me/.claude/tools';
  const r = m.rewriteTools(t, 'D:/snap/', live, home);
  check(
    'rewriteTools: ~, backslash and /c/ forms rewritten',
    r.n === 3 &&
      r.text.startsWith('node D:/snap/review-sweep.mjs') &&
      r.text.includes('D:/snap\\x.mjs') &&
      r.text.includes('D:/snap/y.mjs'),
    r.text,
  );
  check(
    'isLiveTools: the live dir in any slash/case form is live, a snapshot or sibling is not',
    m.isLiveTools('C:\\Users\\me\\.claude\\tools\\', live) &&
      m.isLiveTools('c:/users/ME/.claude/tools', live) &&
      !m.isLiveTools('D:/snap', live) &&
      !m.isLiveTools('C:/Users/me/.claude/tools-baseline', live),
  );
  // The kit has no fixed install path: the live tools dir is the one the bench itself runs from.
  const kitTools = path.dirname(TOOL);
  const own = m.rewriteTools(
    `node "${kitTools.replace(/\\/g, '/')}/review-sweep.mjs" all · ${kitTools}${path.sep}x.mjs · ${kitTools}-baseline/y.mjs`,
    'D:/snap',
  );
  check(
    "kit default: the live tools dir is the bench's own dir (both slash forms rewritten, a sibling kept)",
    m.isLiveTools(kitTools) &&
      !m.isLiveTools(path.dirname(kitTools)) &&
      own.n === 2 &&
      own.text.startsWith('node "D:/snap/review-sweep.mjs"') &&
      own.text.includes(`${kitTools}-baseline/y.mjs`),
    own.text,
  );
  const posix = m.rewriteTools(
    'node /home/me/kit/tools/a.mjs · ~/kit/tools/b.mjs · /home/me/kit/tools2/c.mjs',
    '/snap',
    '/home/me/kit/tools',
    '/home/me',
  );
  check(
    'rewriteTools: a POSIX live dir, absolute and ~ forms rewritten, a sibling kept',
    posix.n === 2 && posix.text === 'node /snap/a.mjs · /snap/b.mjs · /home/me/kit/tools2/c.mjs',
    posix.text,
  );
  check(
    'rewriteTools: a sibling dir (tools-baseline) is not the live tools dir',
    r.text.includes('C:/Users/me/.claude/tools-baseline/z.mjs'),
  );
  const f = m.benchFidelity(
    'First `node X/review-sweep.mjs all --base 07f6f387ca --paths a.go`: rows.\nThe reviewed tree stays untouched: probes run from C:/clone.',
    { head: 'd371e5acb49d', repo: 'C:/work/r', clone: 'C:/clone' },
  );
  check(
    'benchFidelity: a base-only sweep is pinned to --head',
    f.pinned === 1 && f.text.includes('--base 07f6f387ca --head d371e5acb49d --paths'),
  );
  check(
    'benchFidelity: a second pass pins nothing twice',
    m.benchFidelity(f.text, { head: 'd371e5acb49d', repo: 'C:/work/r', clone: 'C:/clone' })
      .pinned === 0,
  );
  check(
    'benchFidelity: the clone line follows the scratch line',
    /stays untouched[^\n]*\nThe checkout C:\/work\/r is on another commit: read whole files from C:\/clone/.test(
      f.text,
    ),
  );
}

// 8. Cost from subagent transcripts.
{
  const dir = path.join(root, 'subagents');
  mkdirSync(dir, { recursive: true });
  const u = (i, o, cc, cr) => ({
    input_tokens: i,
    output_tokens: o,
    cache_creation_input_tokens: cc,
    cache_read_input_tokens: cr,
  });
  const rows = (prompt, msgs) =>
    [
      {
        type: 'user',
        message: { role: 'user', content: prompt },
        timestamp: '2026-11-03T10:00:00Z',
      },
      ...msgs.map(([id, usage, tool, ts]) => ({
        type: 'assistant',
        message: { id, usage, content: tool ? [{ type: 'tool_use', id: tool }] : [] },
        timestamp: ts,
      })),
    ]
      .map((x) => JSON.stringify(x))
      .join('\n');
  writeFileSync(
    path.join(dir, 'agent-1.jsonl'),
    rows('brief .agent/tmp/review-c1-base/plan/lane-A-r1.prompt.md', [
      ['m1', u(10, 5, 100, 0), 't1', '2026-11-03T10:01:00Z'],
      ['m1', u(10, 5, 100, 0), 't2', '2026-11-03T10:01:01Z'],
      ['m2', u(2, 7, 0, 50), null, '2026-11-03T10:06:00Z'],
    ]),
  );
  writeFileSync(
    path.join(dir, 'agent-2.jsonl'),
    rows('brief .agent/tmp/review-c1-base2/plan/lane-A-r1.prompt.md', [
      ['m9', u(1000, 1000, 0, 0), null, '2026-11-03T12:00:00Z'],
    ]),
  );
  const c = m.sessionCost(dir, /review-c1-base(?![\w-])/);
  check('cost: only agents naming the run (base, not base2)', c.spawns === 1, JSON.stringify(c));
  check(
    'cost: tokens summed once per message.id',
    c.tokens === 10 + 5 + 100 + 2 + 7 + 50 && c.turns === 2,
    `${c.tokens} ${c.turns}`,
  );
  check('cost: tool calls and per-turn rate', c.toolCalls === 2 && c.toolsPerTurn === 1);
  check(
    'cost: peak context = input + cache write + cache read',
    c.peakContext === 110,
    String(c.peakContext),
  );
  check('cost: wall minutes first → last timestamp', c.wallMinutes === 6);
}

// 9. End to end: seed on a throwaway repo (TS + docs, no Go toolchain needed) and score it.
{
  const repo = path.join(root, 'repo');
  mkdirSync(path.join(repo, 'src'), { recursive: true });
  mkdirSync(path.join(repo, 'docs'), { recursive: true });
  const g = (...a) => spawnSync('git', ['-C', repo, ...a], { encoding: 'utf8' });
  g('init', '-q', '-b', 'main');
  g('config', 'user.email', 't@t');
  g('config', 'user.name', 't');
  writeFileSync(path.join(repo, 'src', 'a.ts'), 'export const x = 1;\n');
  writeFileSync(path.join(repo, 'docs', 'limits.md'), '# Limits\n');
  g('add', '-A');
  g('commit', '-qm', 'base');
  const base = g('rev-parse', 'HEAD').stdout.trim();
  const body = [
    'export async function f(a: number, b: number) {',
    '  if (a <= b) {',
    '    return 1;',
    '  }',
    '',
    '',
    '',
    '',
    '',
    '',
    '  const v = a ?? b;',
    '  return v;',
    '}',
  ];
  writeFileSync(path.join(repo, 'src', 'a.ts'), 'export const x = 1;\n' + body.join('\n') + '\n');
  writeFileSync(
    path.join(repo, 'docs', 'limits.md'),
    '# Limits\n\nUp to 10 requests per minute.\n',
  );
  writeFileSync(path.join(repo, 'src', 'a.test.ts'), 'if (a <= b) { x = a ?? b }\n');
  g('add', '-A');
  g('commit', '-qm', 'feat: limits');
  const head = g('rev-parse', 'HEAD').stdout.trim();
  const mr = path.join(root, 'mr.txt');
  writeFileSync(mr, 'Описание MR\n');
  const cases = path.join(root, 'cases');
  const r = spawnSync(
    process.execPath,
    [
      TOOL,
      'seed',
      '--repo',
      repo,
      '--base',
      base,
      '--head',
      head,
      '--case',
      'c1',
      '--n',
      '5',
      '--rng',
      '3',
      '--mr-text',
      mr,
      '--cases',
      cases,
      '--scratch',
      path.join(root, 'scratch'),
    ],
    { encoding: 'utf8' },
  );
  check('seed: exits 0', r.status === 0, r.stderr + r.stdout);
  const caseDir = path.join(cases, 'c1');
  const c = existsSync(path.join(caseDir, 'case.json'))
    ? JSON.parse(readFileSync(path.join(caseDir, 'case.json'), 'utf8'))
    : {};
  const truth = existsSync(path.join(caseDir, 'truth.json'))
    ? JSON.parse(readFileSync(path.join(caseDir, 'truth.json'), 'utf8'))
    : [];
  check(
    'seed: case.json names base, head, seededHead, kind',
    c.base === base &&
      c.head === head &&
      /^[0-9a-f]{40}$/.test(c.seededHead ?? '') &&
      c.kind === 'seeded',
  );
  check(
    'seed: refs/bench/<case> keeps the seeded commit',
    g('rev-parse', 'refs/bench/c1').stdout.trim() === c.seededHead,
  );
  check(
    'seed: HEAD, the branch and the working tree are untouched',
    g('rev-parse', 'HEAD').stdout.trim() === head &&
      g('status', '--porcelain').stdout === '' &&
      g('symbolic-ref', 'HEAD').stdout.trim() === 'refs/heads/main',
  );
  check(
    'seed: the seeded commit sits on head',
    g('rev-parse', `${c.seededHead}^`).stdout.trim() === head,
  );
  check(
    'seed: three seeds — boundary, nullish-or, doc-number',
    truth
      .map((t) => t.op)
      .sort()
      .join(',') === 'boundary,doc-number,nullish-or',
    JSON.stringify(truth),
  );
  check(
    'seed: the test file is never mutated',
    !g('diff', '--name-only', head, c.seededHead).stdout.includes('a.test.ts'),
  );
  check(
    'seed: every truth line reads back at its seeded line',
    truth.every(
      (t) => g('show', `${c.seededHead}:${t.file}`).stdout.split('\n')[t.line - 1] === t.after,
    ),
  );
  check(
    'seed: the truth never enters the commit message',
    !/S0|boundary|seed/i.test(g('log', '-1', '--format=%B', c.seededHead).stdout),
  );
  check(
    'seed: mr-text.md carries the language marker',
    readFileSync(path.join(caseDir, 'mr-text.md'), 'utf8').startsWith(
      '<!-- lang:ru -->\nОписание MR',
    ),
  );

  const run = path.join(repo, '.agent', 'tmp', 'review-c1-base');
  mkdirSync(run, { recursive: true });
  const ts = truth.find((t) => t.file === 'src/a.ts' && t.op === 'boundary');
  writeFileSync(
    path.join(run, 'lane-A.md'),
    `# Lane A r1 — c001\n| src/a.ts | read |\n- CA1 · src/a.ts:${ts?.line} · off by one · 🔴 · high · a == b\n`,
  );
  writeFileSync(
    path.join(run, 'lane-B-r2.md'),
    '# Lane B r2\n- CB1 · docs/limits.md:30 · far away · 🟢 · low · read\n',
  );
  const s = spawnSync(
    process.execPath,
    [
      TOOL,
      'score',
      '--case',
      'c1',
      '--label',
      'base',
      '--cases',
      cases,
      '--write',
      '--session-dir',
      path.join(root, 'subagents'),
    ],
    { encoding: 'utf8' },
  );
  check(
    'score: recall 1/3 printed',
    s.status === 0 && /recall 1\/3 \(33%\)/.test(s.stdout),
    s.stdout + s.stderr,
  );
  check(
    'score: cost counts the run c1-base only, not c1-base2',
    /cost: 1 spawn\(s\) · 174 tokens/.test(s.stdout),
    s.stdout,
  );
  check(
    'score: candidate lines counted over both lane files',
    /candidate lines: 2 in 2 file/.test(s.stdout),
    s.stdout,
  );
  check(
    'score: --write appends one history row',
    readFileSync(path.join(caseDir, 'history.jsonl'), 'utf8').trim().split('\n').length === 1,
  );
}

// 10. Go seeds are built before they are kept: a seed the compiler rejects is replaced (needs `go`).
if (spawnSync('go', ['version'], { encoding: 'utf8' }).status === 0) {
  const repo = path.join(root, 'gorepo');
  mkdirSync(repo, { recursive: true });
  const g = (...a) => spawnSync('git', ['-C', repo, ...a], { encoding: 'utf8' });
  g('init', '-q', '-b', 'main');
  g('config', 'user.email', 't@t');
  g('config', 'user.name', 't');
  writeFileSync(path.join(repo, 'go.mod'), 'module example.com/p\n\ngo 1.21\n');
  writeFileSync(path.join(repo, 'p.go'), 'package p\n');
  g('add', '-A');
  g('commit', '-qm', 'base');
  const base = g('rev-parse', 'HEAD').stdout.trim();
  // drop-defer here leaves `f` unused → "declared and not used": the build must veto it.
  writeFileSync(
    path.join(repo, 'p.go'),
    [
      'package p',
      '',
      'import "os"',
      '',
      'func F() error {',
      '\tf, err := os.Open("x")',
      '\tif err != nil {',
      '\t\treturn err',
      '\t}',
      '\t_ = 1',
      '\t_ = 2',
      '\t_ = 3',
      '\t_ = 4',
      '\t_ = 5',
      '\tdefer f.Close()',
      '\treturn nil',
      '}',
      '',
    ].join('\n'),
  );
  g('add', '-A');
  g('commit', '-qm', 'feat');
  const head = g('rev-parse', 'HEAD').stdout.trim();
  const cases = path.join(root, 'gocases');
  const r = spawnSync(
    process.execPath,
    [
      TOOL,
      'seed',
      '--repo',
      repo,
      '--base',
      base,
      '--head',
      head,
      '--case',
      'g1',
      '--n',
      '5',
      '--cases',
      cases,
      '--scratch',
      path.join(root, 'goscratch'),
    ],
    { encoding: 'utf8' },
  );
  const truth = existsSync(path.join(cases, 'g1', 'truth.json'))
    ? JSON.parse(readFileSync(path.join(cases, 'g1', 'truth.json'), 'utf8'))
    : [];
  check(
    'go seed: the compile-breaking drop-defer is rejected by the build',
    /rejected \(build\): p\.go:15 drop-defer/.test(r.stdout),
    r.stdout + r.stderr,
  );
  check(
    'go seed: the compiling swallow-err is kept',
    truth.length === 1 && truth[0].op === 'swallow-err' && truth[0].after === '\t\treturn nil',
    JSON.stringify(truth),
  );
  check(
    'go seed: the throwaway worktree is gone afterwards',
    !existsSync(path.join(root, 'goscratch', 'wt')) &&
      !g('worktree', 'list').stdout.includes('goscratch'),
  );
} else console.log('skip  go seed build check — no go toolchain');

console.log(`\n${pass} passed, ${fails.length} failed`);
if (fails.length) {
  for (const f of fails) console.log(`  - ${f}`);
  process.exitCode = 1;
}
