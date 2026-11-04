// review-sweep: the hunt passes that run as a command so a lane cannot skip them. What is pinned:
// a table row fires only on its language, a removed Close/Rollback/validation is reported unless the
// line merely moved, a guard lost inside a function is counted, a renamed env var still read by the
// chart is found, a new env knob shows its deploy side, and every mutant `find` is locatable; `--paths @file`
// reads one path per line; lint keeps analyzer rows on added lines only (live: vet/staticcheck/ruff/semgrep flag
// the new defect and not the identical old one), caps per file, survives a failing tool with exit 0.
// Kit port of the personal layer's review-sweep test.
// Run: node review-sweep.selftest.mjs (REVIEW_SWEEP_TOOL = the tool under test; default the built-in kit)
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';

const TOOL =
  process.env.REVIEW_SWEEP_TOOL ||
  path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    '../../../../../assets/kit/agentdeck-kit/tools/review-sweep.mjs',
  );
let pass = 0;
const fails = [];
const check = (name, ok, detail = '') => {
  if (ok) pass++;
  else fails.push(`${name}${detail ? ': ' + detail : ''}`);
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${name}`);
};
const root = mkdtempSync(path.join(os.tmpdir(), 'review-sweep-'));
process.on('exit', () => rmSync(root, { recursive: true, force: true }));
const git = (repo, ...a) =>
  spawnSync('git', ['-C', repo, ...a], { encoding: 'utf8' }).stdout.trim();
const run = (...a) => spawnSync(process.execPath, [TOOL, ...a], { encoding: 'utf8' });

function write(dir, files) {
  for (const [f, text] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(dir, f)), { recursive: true });
    writeFileSync(path.join(dir, f), text);
  }
}
function repo(name, base, head) {
  const dir = path.join(root, name);
  mkdirSync(dir, { recursive: true });
  git(dir, 'init', '-q');
  git(dir, 'config', 'user.email', 't@t');
  git(dir, 'config', 'user.name', 't');
  write(dir, base);
  git(dir, 'add', '-A');
  git(dir, 'commit', '-qm', 'base');
  const sha = git(dir, 'rev-parse', 'HEAD');
  for (const f of Object.keys(base)) if (!(f in head)) rmSync(path.join(dir, f));
  write(dir, head);
  git(dir, 'add', '-A');
  git(dir, 'commit', '-qm', 'head');
  return { dir, base: sha };
}

const BASE = {
  'svc/api/handler.go': [
    'package api',
    '',
    'func Get(w http.ResponseWriter, r *http.Request) {',
    '\tif err := RequireRole(r, "admin"); err != nil {',
    '\t\treturn',
    '\t}',
    '\tValidateID(r, max_page_size)',
    '\trows, _ := db.Query(r.Context(), q)',
    '\tdefer rows.Close()',
    '}',
    '',
    'func Put(w http.ResponseWriter, r *http.Request) {',
    '\tRequireRole(r, "admin", max_page_size)',
    '}',
    '',
  ].join('\n'),
  'svc/config.go': 'package svc\n\nvar limit = os.Getenv("UPLOAD_MAX_BYTES")\n',
  'deploy/values.yaml': 'env:\n  UPLOAD_MAX_BYTES: "1048576"\n',
  'ui/list.tsx': 'export function List() {\n  return null\n}\n',
  'svc/io.go':
    'package svc\n\nfunc a() {\n\tfor _, f := range fs {\n\t\tdefer f.Close()\n\t\tx()\n\t\ty()\n\t\tz()\n\t}\n}\n',
};
const HEAD = {
  'svc/api/handler.go': [
    'package api',
    '',
    'func Get(w http.ResponseWriter, r *http.Request) {',
    '\trows, _ := db.Query(context.Background(), q)',
    '\tif len(rows) > 10 {',
    '\t\treturn',
    '\t}',
    '}',
    '',
    'func Put(w http.ResponseWriter, r *http.Request) {',
    '\tRequireRole(r, "admin", max_page_size)',
    '}',
    '',
    'func Delete(w http.ResponseWriter, r *http.Request) {',
    '\tif len(rows) > 10 {',
    '\t\treturn',
    '\t}',
    '}',
    '',
    'func Create(w http.ResponseWriter, r *http.Request) {',
    '\tdb.Exec(r.Context(), ins)',
    '}',
    '',
    'func writeErr(w http.ResponseWriter, r *http.Request) {',
    '\tw.WriteHeader(500)',
    '}',
    '',
  ].join('\n'),
  'svc/a/x.go': 'package a\n\nfunc (o *O) Delete(id int) {\n}\n',
  'svc/api/routes.go':
    'package api\n\nfunc routes(r chi.Router, h *H) {\n\tr.With(RequireRole("admin")).Post("/x", h.Create)\n\tr.Delete("/x", h.Delete)\n}\n',
  'svc/config.go':
    'package svc\n\nvar limit = os.Getenv("UPLOAD_LIMIT_BYTES")\nvar stream = envInt("STREAM_IDLE_SECONDS", 30)\n',
  'deploy/values.yaml': 'env:\n  UPLOAD_MAX_BYTES: "1048576"\n',
  'ui/list.tsx':
    'export function List({ items }) {\n  return <div>{items.length && <b>{items.length}</b>}</div>\n}\n',
  'ui/notes.md': 'context.Background() mentioned in prose\n',
  'svc/util/trim.go': 'package util\n\nfunc Trim(s string) string {\n\treturn s\n}\n',
  'svc/io.go':
    'package svc\n\nfunc a() {\n\tfor _, f := range fs {\n\t\tx()\n\t\ty()\n\t\tz()\n\t\tdefer f.Close()\n\t}\n}\n',
  'svc/once.go':
    'package svc\n\nfunc b() {\n\tdefer mu.Unlock()\n\tfor k, _ := range m {\n\t\t_ = k\n\t}\n}\n',
  'svc/api/handler_test.go':
    'package api\n\nfunc TestGet(t *testing.T) {\n\tctx := context.Background()\n}\n',
  'deploy/templates/svc.yaml':
    'env:\n  - name: STREAM_IDLE_SECONDS\n    value: {{ .Values.idle | default 30 | quote }}\n',
};
const { dir, base } = repo('r', BASE, HEAD);

// 1. sweep: table rows by language, removed-line list.
{
  const r = run('sweep', '--repo', dir, '--base', base);
  const o = r.stdout;
  check('sweep: runs', r.status === 0, r.stderr);
  const hit = (row, loc) =>
    new RegExp(`^${row}[^\\n]* — \\d+\\n(    .*\\n)*    ${loc} `, 'm').test(o);
  check(
    'sweep: Go row fires on the .go line',
    hit('\\+ \\[Go\\] on a request path', 'svc/api/handler\\.go:4'),
    o,
  );
  check('sweep: …and not on prose in .md', !/notes\.md/.test(o), o);
  check('sweep: …nor in a test file', !/handler_test\.go/.test(o), o);
  check(
    'sweep: frontend row fires on .tsx',
    hit('\\+ \\[state\\] renders a literal 0', 'ui/list\\.tsx:2'),
    o,
  );
  check(
    'sweep: a removed defer Close is reported',
    hit('- a Close stopped happening', 'svc/api/handler\\.go:9'),
    o,
  );
  check(
    'sweep: a removed validation is reported',
    hit('- a guard or validation removed', 'svc/api/handler\\.go:7'),
    o,
  );
  check(
    'sweep: a defer inside a for is reported',
    hit('\\+ \\[Go\\] inside a for', 'svc/io\\.go:8'),
    o,
  );
  check('sweep: …a defer at function level is not', !/svc\/once\.go:4 /.test(o), o);
  const closes = o.split(/^(?=[-+] |## )/m).find((b) => b.startsWith('- a Close')) ?? '';
  check(
    'sweep: a line that merely moved is not a removal',
    closes.includes('handler.go:9') && !closes.includes('io.go'),
    o,
  );
  check(
    'sweep: a range blank is not an error discard',
    !/once\.go:5 /.test(o) && hit('\\+ \\[Go\\] error discarded', 'svc/once\\.go:6'),
    o,
  );
  check('sweep: header says candidates', /candidates, not findings/.test(o));
  const capped = run('sweep', '--repo', dir, '--base', base, '--cap', '1').stdout;
  check(
    'sweep: --cap folds the rest into a file list',
    /^ {4}\+1 more in svc\/once\.go$/m.test(capped),
    capped,
  );
}

// 2. guards: dropped count in an existing function; a new handler with none.
{
  const o = run('guards', '--repo', dir, '--base', base).stdout;
  check('guards: Get lost its guards', /svc\/api\/handler\.go Get: guard calls 2 → 0/.test(o), o);
  check('guards: Put kept its guard → silent', !/ Put:/.test(o), o);
  check(
    'guards: new Delete handler without a guard, pointed at its route',
    /handler\.go: 1 new entry point, no guard in the body or on the route line — [^\n]*Delete \(svc\/api\/routes\.go:5\)/.test(
      o,
    ),
    o,
  );
  check('guards: a guard on the route line covers Create', !/Create/.test(o), o);
  check('guards: an unexported helper taking w is no entry point', !/writeErr/.test(o), o);
  check('guards: a new helper that is no entry point is not', !/trim\.go/.test(o), o);
}

// 3. renames: the old env var left the code but the chart still sets it.
{
  const o = run('renames', '--repo', dir, '--base', base).stdout;
  check(
    'renames: UPLOAD_MAX_BYTES still in values.yaml',
    /UPLOAD_MAX_BYTES: gone from the changed files, still in deploy\/values\.yaml/.test(o),
    o,
  );
  check('renames: the new name is not reported', !/UPLOAD_LIMIT_BYTES/.test(o), o);
  check(
    'renames: a name a changed file still uses is not reported',
    /UPLOAD_MAX_BYTES/.test(o) && !/max_page_size/.test(o),
    o,
  );
}

// 4. knobs: deploy side found or named absent; a helper default captured.
{
  const o = run('knobs', '--repo', dir, '--base', base).stdout;
  check(
    'knobs: new var with no deploy row',
    /UPLOAD_LIMIT_BYTES \(svc\/config\.go:3\) code default — · deploy none/.test(o),
    o,
  );
  check(
    'knobs: helper default and a chart `| default` under the name',
    /STREAM_IDLE_SECONDS \(svc\/config\.go:4\) code default 30 · deploy deploy\/templates\/svc\.yaml:2 · `\| default` at deploy\/templates\/svc\.yaml:2/.test(
      o,
    ),
    o,
  );
}

// 5. mutants: a plan mustfail can apply — every find present in the head file, nth when repeated.
{
  const out = path.join(dir, 'm.json');
  const r = run(
    'mutants',
    '--repo',
    dir,
    '--base',
    base,
    '--test',
    'TestGet',
    '--cmd',
    'go test ./...',
    '--out',
    out,
  );
  const plan = JSON.parse(readFileSync(out, 'utf8'));
  check('mutants: runs', r.status === 0 && /mutants: \d+ →/.test(r.stdout), r.stdout + r.stderr);
  check(
    'mutants: negates the new if',
    plan.some((m) => m.find === 'if len(rows) > 10 {' && m.replace === 'if !(len(rows) > 10) {'),
    JSON.stringify(plan),
  );
  check(
    'mutants: every find occurs in its file',
    plan.every((m) => readFileSync(path.join(dir, m.file), 'utf8').includes(m.find)),
  );
  const twice = plan.filter((m) => m.find === 'if len(rows) > 10 {').map((m) => m.nth);
  check(
    'mutants: a repeated line gets one mutant per occurrence, nth 1 and 2',
    twice.join() === '1,2',
    JSON.stringify(twice),
  );
  check(
    'mutants: `test` is the test NAME (mustfail semantics), the command goes to the printed --cmd',
    plan.every((m) => m.test === 'TestGet') && r.stdout.includes('--cmd "go test ./..." --mutants'),
    r.stdout,
  );
  check(
    'mutants: no mutant in markdown',
    plan.every((m) => !m.file.endsWith('.md')),
  );
}

// 6. the plan is accepted by the real mustfail, which kills the boundary mutant a boundary test pins
//    (skipped, and said so, when mustfail is not installed next to this tool)
{
  const MUSTFAIL = path.join(path.dirname(TOOL), 'mustfail.mjs');
  if (!existsSync(MUSTFAIL)) console.log('skip  mutants → mustfail: tools/mustfail.mjs absent');
  else {
    const { dir: fx, base: fb } = repo(
      'mf',
      { 'package.json': '{"type":"module"}\n', 'lim.mjs': 'export const x = 1\n' },
      {
        'package.json': '{"type":"module"}\n',
        'lim.mjs':
          'export function allowed(n) {\n  if (n <= 10) {\n    return true\n  }\n  return false\n}\n',
        'check.mjs':
          "import { allowed } from './lim.mjs'\nif (allowed(10) !== true || allowed(11) !== false) { console.error('FAIL boundary'); process.exit(1) }\nconsole.log('ok')\n",
      },
    );
    const out = path.join(fx, 'mut.json');
    run('mutants', '--repo', fx, '--base', fb, '--out', out);
    const plan = JSON.parse(readFileSync(out, 'utf8'));
    const mf = spawnSync(
      process.execPath,
      [MUSTFAIL, '--cwd', fx, '--cmd', 'node check.mjs', '--mutants', out],
      { encoding: 'utf8' },
    );
    check(
      'mutants → mustfail: the plan negates the if',
      plan.some((m) => m.find === 'if (n <= 10) {'),
      JSON.stringify(plan),
    );
    check(
      'mutants → mustfail: accepted and every mutant killed',
      mf.status === 0 &&
        /MUSTFAIL·mutants: [1-9]\d* killed · 0 survived/.test(mf.stdout) &&
        /control survived/.test(mf.stdout),
      mf.stdout.slice(-900) + mf.stderr.slice(-400),
    );
  }
}

// 7a. `--paths` (measured): a path with spaces, or a space-separated list, swept 0 lines with exit 0 and
//     «zero rows is a result» recorded it as a checked zone. Now an unmatched path is an error, a path with
//     spaces works, and the header says how many given paths matched. `SWEEP` lets the same checks run
//     against another copy of the tool (red-before on the pre-fix file).
{
  const handler = (close) =>
    [
      'package api',
      '',
      'func Get() {',
      '\trows, _ := db.Query(q)',
      ...(close ? ['\tdefer rows.Close()'] : []),
      '}',
      '',
    ].join('\n');
  const { dir, base } = repo(
    'paths',
    {
      'my svc/api/handler.go': handler(true),
      'other/h.go': handler(true),
      'docs/readme.md': 'x\n',
    },
    {
      'my svc/api/handler.go': handler(false),
      'other/h.go': handler(false),
      'docs/readme.md': 'y\n',
    },
  );
  const sweep = (paths) =>
    spawnSync(
      process.execPath,
      [process.env.SWEEP || TOOL, 'sweep', '--repo', dir, '--base', base, '--paths', paths],
      { encoding: 'utf8' },
    );
  const hit = /a Close stopped happening — (\d+)/;

  let r = sweep('my svc/api');
  check(
    'paths: one path with a space is swept',
    r.status === 0 && hit.exec(r.stdout)?.[1] === '1',
    r.stdout + r.stderr,
  );
  check(
    'paths: the header says N of M given matched',
    /paths: 1 of 1 given matched, 1 files swept/.test(r.stdout),
    r.stdout,
  );

  r = sweep('my svc/api other');
  check(
    'paths: a space-separated list with a spaced directory resolves longest-first (2 rows)',
    r.status === 0 &&
      hit.exec(r.stdout)?.[1] === '2' &&
      /paths: 2 of 2 given matched/.test(r.stdout),
    r.stdout + r.stderr,
  );

  r = sweep('my svc/api,other');
  check(
    'paths: comma list, 2 rows',
    r.status === 0 && hit.exec(r.stdout)?.[1] === '2',
    r.stdout + r.stderr,
  );

  r = sweep('my svc/api,nope/missing.go');
  check(
    'paths: an unmatched path = exit 2 naming it, nothing printed to stdout',
    r.status === 2 &&
      /"nope\/missing\.go"/.test(r.stderr) &&
      /swept 0 of 2 given/.test(r.stderr) &&
      !r.stdout.trim(),
    `${r.status} ${r.stderr}`,
  );

  r = sweep('totally missing');
  check(
    'paths: only unmatched words → exit 2',
    r.status === 2 && /"totally"/.test(r.stderr) && /"missing"/.test(r.stderr),
    `${r.status} ${r.stderr}`,
  );

  r = sweep('docs/readme.md');
  check(
    'paths: a changed file with no hunk lines is matched (0 rows is then a real result)',
    r.status === 0 && /paths: 1 of 1 given matched/.test(r.stdout),
    r.stdout + r.stderr,
  );

  r = sweep('other/*.go');
  check(
    'paths: a glob matching a changed file passes through git',
    r.status === 0 && hit.exec(r.stdout)?.[1] === '1',
    r.stdout + r.stderr,
  );

  r = sweep('nothing/*.go');
  check('paths: a glob matching nothing = exit 2', r.status === 2, `${r.status} ${r.stderr}`);

  r = spawnSync(
    process.execPath,
    [process.env.SWEEP || TOOL, 'sweep', '--repo', dir, '--base', 'deadbeef00', '--paths', 'other'],
    { encoding: 'utf8' },
  );
  check(
    'paths: an unknown base is an error, not an empty clean diff',
    r.status === 2 && /not a commit/.test(r.stderr),
    `${r.status} ${r.stderr}`,
  );
}

// 7. usage error without --base.
check('usage: no --base → exit 2', run('sweep').status === 2);

// 8. `--paths @file`: one path per line (the planner's 7 KB inline list moves to a file). A comma inside a line is
//    part of the path — the same path inline is split at the comma and refused.
{
  const handler = (close) =>
    [
      'package api',
      '',
      'func Get() {',
      '\trows, _ := db.Query(q)',
      ...(close ? ['\tdefer rows.Close()'] : []),
      '}',
      '',
    ].join('\n');
  const { dir, base } = repo(
    'atfile',
    {
      'my svc/api/handler.go': handler(true),
      'odd,dir/h.go': handler(true),
      'other/h.go': handler(true),
    },
    {
      'my svc/api/handler.go': handler(false),
      'odd,dir/h.go': handler(false),
      'other/h.go': handler(false),
    },
  );
  const list = path.join(root, 'paths.txt');
  const sweep = (paths) =>
    spawnSync(
      process.execPath,
      [process.env.SWEEP || TOOL, 'sweep', '--repo', dir, '--base', base, '--paths', paths],
      { encoding: 'utf8' },
    );
  const hit = /a Close stopped happening — (\d+)/;

  writeFileSync(list, 'my svc/api\r\nodd,dir/h.go\r\n\r\n');
  let r = sweep(`@${list}`);
  check(
    '@file: CRLF lines, a spaced dir and a comma path → 2 rows, 2 of 2 matched',
    r.status === 0 &&
      hit.exec(r.stdout)?.[1] === '2' &&
      /paths: 2 of 2 given matched/.test(r.stdout),
    r.stdout + r.stderr,
  );
  check('@file: the unlisted file is not swept', !/other\/h\.go/.test(r.stdout), r.stdout);

  r = sweep('odd,dir/h.go');
  check(
    '@file: the same comma path inline is split and refused (why @file exists)',
    r.status === 2,
    `${r.status} ${r.stderr}`,
  );

  writeFileSync(list, '\n  \n');
  r = sweep(`@${list}`);
  check(
    '@file: an empty list = exit 2, not a sweep of everything',
    r.status === 2 && /lists no path/.test(r.stderr) && !r.stdout.trim(),
    `${r.status} ${r.stderr}`,
  );

  r = sweep(`@${path.join(root, 'nope.txt')}`);
  check(
    '@file: a missing file = exit 2',
    r.status === 2 && /cannot read/.test(r.stderr),
    `${r.status} ${r.stderr}`,
  );

  // a list made by plain `git diff --name-only` C-quotes non-ASCII names (seen on QA/…/<non-Latin name>.md)
  const cyr = 'docs/ТК-1.md';
  const { dir: d2, base: b2 } = repo(
    'quoted',
    { [cyr]: 'a\n', 'x.go': 'package x\n' },
    { [cyr]: 'b\n', 'x.go': 'package x\n\nvar Y = 1\n' },
  );
  const quoted = git(d2, '-c', 'core.quotePath=true', 'diff', '--name-only', b2, 'HEAD');
  writeFileSync(list, `${quoted}\n`);
  r = spawnSync(
    process.execPath,
    [process.env.SWEEP || TOOL, 'sweep', '--repo', d2, '--base', b2, '--paths', `@${list}`],
    { encoding: 'utf8' },
  );
  check(
    '@file: git C-quoted names are decoded (fixture really quoted)',
    /^"docs\/\\\d{3}/m.test(quoted) &&
      r.status === 0 &&
      /paths: 2 of 2 given matched/.test(r.stdout),
    `${quoted}\n${r.status} ${r.stdout}${r.stderr}`,
  );
}

// 9. lint, pure parts: added-line filter, dedupe, cap, row format, path mapping, tool output parsers, ruleset cache.
const S = await import(pathToFileURL(TOOL).href);
{
  const d = {
    added: [
      { file: 'a.go', line: 3, text: '' },
      { file: 'a.go', line: 5, text: '' },
      { file: 'b.py', line: 1, text: '' },
    ],
  };
  const idx = S.addedIndex(d);
  const f = (file, line, rule = 'R1', tool = 'vet') => ({ file, line, rule, tool, message: 'm' });
  const k = S.keepAdded(
    [
      f('a.go', 3),
      f('a.go', 4),
      f('a.go', 3),
      f('a.go', 3, 'R2'),
      f('c.go', 3),
      f(null, 3),
      f('b.py', 1, 'F401', 'ruff'),
    ],
    idx,
  );
  check(
    'lint: only added lines survive, a repeat of file:line+tool/rule is dropped',
    k.kept.map((x) => `${x.file}:${x.line}:${x.rule}`).join() === 'a.go:3:R1,a.go:3:R2,b.py:1:F401',
    JSON.stringify(k.kept),
  );
  check('lint: findings off the added lines are counted', k.outside === 3, String(k.outside));

  const many = Array.from({ length: 17 }, (_, i) => ({
    file: 'a.go',
    line: 17 - i,
    tool: 'staticcheck',
    rule: 'SA4006',
    message: 'x',
  }));
  const rows = S.capRows(
    [...many, { file: '0.go', line: 1, tool: 'vet', rule: 'printf', message: 'y' }],
    15,
  );
  check(
    'lint: cap 15 per file + one «+N more» line, files sorted',
    rows.length === 17 && rows[0].startsWith('0.go:1 ') && rows.at(-1) === 'a.go · +2 more',
    rows.join('\n'),
  );
  check(
    'lint: lines sorted numerically (9 before 10)',
    rows[9] === 'a.go:9 · staticcheck/SA4006 · x' &&
      rows[10] === 'a.go:10 · staticcheck/SA4006 · x',
    rows.join('\n'),
  );
  check('lint: cap 0 = all rows', S.capRows(many, 0).length === 17);

  check(
    'lint: row format, whitespace collapsed',
    S.formatLintRow({
      file: 'svc/a.go',
      line: 12,
      tool: 'semgrep',
      rule: 'gosql-sqli',
      message: 'SQL built\n   by concatenation',
    }) === 'svc/a.go:12 · semgrep/gosql-sqli · SQL built by concatenation',
  );
  const long = S.formatLintRow({
    file: 'a',
    line: 1,
    tool: 't',
    rule: 'r',
    message: 'x'.repeat(400),
  });
  check(
    'lint: a long message is cut with an ellipsis',
    long.endsWith('…') && long.length < 220,
    String(long.length),
  );

  const files = new Map([
    ['inst/a.go', 0],
    ['a.go', 0],
    ['q/x.py', 0],
  ]);
  check(
    'lint: cwd-relative backslash path → repo path',
    S.toRel('internal\\..\\a.go', { cwd: '/r/inst', repo: '/r', files }) === 'inst/a.go',
  );
  check(
    'lint: absolute long name vs an 8.3 repo path → suffix match, longest wins',
    S.toRel('C:\\Users\\devuser\\T\\wt\\inst\\a.go', {
      cwd: 'C:/Users/DEVUSE~1/T/wt',
      repo: 'C:/Users/DEVUSE~1/T/wt',
      files,
    }) === 'inst/a.go',
  );
  check(
    'lint: a file outside the diff maps to null',
    S.toRel('/r/zzz/b.go', { cwd: '/r', repo: '/r', files }) === null,
  );

  const vet = S.parseVet(
    [
      'go: downloading example.com/x v1.0.0',
      '# example.com/m/svc',
      '{',
      '\t"example.com/m/svc": {',
      '\t\t"printf": [{"posn": "C:\\\\w\\\\svc\\\\a.go:9:2", "message": "fmt.Printf format %d has arg \\"{x}\\" of wrong type"}],',
      '\t\t"lostcancel": {"error": "analysis skipped"}',
      '\t}',
      '}',
      '# example.com/m/other',
      'vet: other\\b.go:3:1: undefined: foo',
    ].join('\n'),
  );
  check(
    'lint: vet JSON parsed, a brace inside a message string survives',
    vet.findings.length === 1 &&
      vet.findings[0].file === 'C:\\w\\svc\\a.go' &&
      vet.findings[0].line === 9 &&
      vet.findings[0].rule === 'printf' &&
      /\{x\}/.test(vet.findings[0].message),
    JSON.stringify(vet),
  );
  check(
    'lint: vet text errors kept, `# pkg` and downloads ignored',
    vet.errors.length === 2 &&
      /analysis skipped/.test(vet.errors[0]) &&
      /undefined: foo/.test(vet.errors[1]),
    JSON.stringify(vet.errors),
  );

  const sc = S.parseStaticcheck(
    '{"code":"U1000","location":{"file":"C:\\\\w\\\\a.go","line":21},"message":"func x is unused"}\n{"code":"compile","location":{"file":"","line":0},"message":"could not load"}\n',
  );
  check(
    'lint: staticcheck finding + compile = error',
    sc.findings.length === 1 &&
      sc.findings[0].rule === 'U1000' &&
      sc.findings[0].line === 21 &&
      sc.errors[0] === 'could not load',
    JSON.stringify(sc),
  );
  const rf = S.parseRuff(
    '[{"code":"F401","message":"`sys` imported but unused","filename":"C:\\\\w\\\\lib.py","location":{"row":2,"column":8}}]',
  );
  check('lint: ruff JSON', rf.findings[0].rule === 'F401' && rf.findings[0].line === 2);
  const sg = S.parseSemgrep(
    JSON.stringify({
      results: [
        {
          check_id: 'go.lang.security.audit.sqli.gosql-sqli',
          path: 'svc\\a.go',
          start: { line: 7 },
          extra: { message: 'm' },
        },
      ],
      errors: [
        { level: 'warn', message: 'syntax' },
        { level: 'error', message: 'rule broke\nmore' },
      ],
    }),
  );
  check(
    'lint: semgrep rule = last id segment, parse warnings are not errors',
    sg.findings[0].rule === 'gosql-sqli' &&
      sg.findings[0].line === 7 &&
      sg.errors.join() === 'rule broke',
    JSON.stringify(sg),
  );

  const st = S.dropStyle(
    [
      'ruff:E501',
      'ruff:I001',
      'ruff:UP035',
      'ruff:W291',
      'staticcheck:ST1005',
      'ruff:F401',
      'ruff:B017',
      'ruff:RUF059',
      'ruff:E711',
      'staticcheck:SA4006',
      'vet:printf',
      'semgrep:I1-like',
    ].map((x) => ({ tool: x.split(':')[0], rule: x.split(':')[1] })),
  );
  check(
    'lint: style codes skipped and counted, defect codes kept',
    st.style === 5 &&
      st.kept.map((f) => f.rule).join() === 'F401,B017,RUF059,E711,SA4006,printf,I1-like',
    JSON.stringify(st),
  );

  check(
    'lint: rulesets follow the languages',
    S.rulesetsFor(['a.go', 'b.tsx']).join() === 'p/default,p/secrets,p/golang,p/typescript' &&
      S.rulesetsFor(['x.md']).join() === 'p/default,p/secrets',
  );

  const cache = path.join(root, 'sgcache');
  mkdirSync(cache, { recursive: true });
  const file = path.join(cache, 'p-golang.yaml');
  writeFileSync(file, 'rules: []\n');
  let calls = 0;
  const ok =
    (body, status = 200) =>
    async () => {
      calls++;
      return { ok: status === 200, status, text: async () => body };
    };
  let e = await S.ensureRuleset('p/golang', { dir: cache, fetchImpl: ok('{"rules":[1]}') });
  check(
    'ruleset: a fresh cache is used offline, no fetch',
    e.state === 'cached' && e.file === file && calls === 0,
    JSON.stringify(e),
  );
  const later = Date.now() + 31 * 24 * 3600 * 1000;
  e = await S.ensureRuleset('p/golang', { dir: cache, fetchImpl: ok('{"rules":[1]}'), now: later });
  check(
    'ruleset: older than 30 days → refetched (JSON body accepted)',
    e.state === 'fetched' && calls === 1 && readFileSync(file, 'utf8') === '{"rules":[1]}',
    JSON.stringify(e),
  );
  e = await S.ensureRuleset('p/golang', { dir: cache, fetchImpl: ok('', 500), now: later });
  check(
    'ruleset: a failed refresh keeps the stale copy and says so',
    e.file === file && /^stale, refresh failed: HTTP 500/.test(e.state),
    JSON.stringify(e),
  );
  e = await S.ensureRuleset('p/python', { dir: cache, fetchImpl: ok('<html>login</html>') });
  check(
    'ruleset: no cache + a non-rules body → null',
    e.file === null &&
      /not a rules file/.test(e.state) &&
      !existsSync(path.join(cache, 'p-python.yaml')),
    JSON.stringify(e),
  );
}

// 10. lint, live: each installed analyzer reports the defect on the ADDED line and stays silent on the same defect
//     in an old line. An analyzer absent here is skipped and said so (nothing is installed by the test).
{
  const goBase = [
    'package main',
    '',
    'import (',
    '\t"fmt"',
    '\t"os"',
    ')',
    '',
    'func main() {',
    '\tfmt.Printf("%d\\n", "old")',
    '\tif len(os.Args) > 5 {',
    '\t\tos.Exit(1)',
    '\t}',
    '}',
    '',
    'func unusedOld() {}',
    '',
  ].join('\n');
  const goHead = [
    'package main',
    '',
    'import (',
    '\t"fmt"',
    '\t"os"',
    ')',
    '',
    'func main() {',
    '\tfmt.Printf("%d\\n", "old")',
    '\tfmt.Printf("%d\\n", "new")',
    '\tif len(os.Args) > 5 {',
    '\t\tos.Exit(1)',
    '\t}',
    '\tif len(os.Args) > 9 {',
    '\t\tos.Exit(2)',
    '\t}',
    '}',
    '',
    'func unusedOld() {}',
    '',
    'func unusedNew() {}',
    '',
  ].join('\n');
  const { dir, base } = repo(
    'lint',
    {
      'go.mod': 'module example.com/lintfx\n\ngo 1.21\n',
      'main.go': goBase,
      'lib.py': 'import os\n',
    },
    {
      'go.mod': 'module example.com/lintfx\n\ngo 1.21\n',
      'main.go': goHead,
      'lib.py': 'import os\nimport sys\n',
      // a second package: vet must get every changed package dir, not just the module root
      // ST1005 (capitalized error string) = a style code: skipped and counted unless --style
      'sub/s.go':
        'package sub\n\nimport (\n\t"errors"\n\t"fmt"\n)\n\n// E is exported.\nvar E = errors.New("Bad thing.")\n\nfunc S() {\n\tfmt.Printf("%s\\n", 1)\n}\n',
    },
  );
  const rule = path.join(root, 'rule.yaml');
  writeFileSync(
    rule,
    'rules:\n- id: test-os-exit\n  pattern: os.Exit(...)\n  message: os.Exit outside main wiring\n  languages: [go]\n  severity: WARNING\n',
  );
  const lint = (...extra) =>
    spawnSync(
      process.execPath,
      [
        TOOL,
        'lint',
        '--repo',
        dir,
        '--base',
        base,
        '--no-install',
        '--semgrep-config',
        rule,
        ...extra,
      ],
      { encoding: 'utf8', timeout: 300000 },
    );
  const r = lint();
  const o = r.stdout;
  check(
    'lint live: exit 0, a section with header lines',
    r.status === 0 && /^## lint — \d+$/m.test(o) && /^# lint wall /m.test(o),
    o + r.stderr,
  );
  const has = (name) =>
    S.findExe(
      name,
      name === 'staticcheck'
        ? [path.join(os.homedir(), 'go', 'bin')]
        : name === 'ruff'
          ? [path.join(os.homedir(), '.local', 'bin')]
          : [],
    );
  if (!has('go')) console.log('skip  lint live go vet: no go toolchain');
  else {
    check('lint live: go vet flags the added Printf', /^main\.go:10 · vet\/printf · /m.test(o), o);
    check(
      'lint live: …and not the same call on an old line',
      !/^main\.go:9 · vet/m.test(o) &&
        /# go vet: 2 rows in [\d.]+s · 1 findings off the added lines dropped/.test(o),
      o,
    );
    check(
      'lint live: go vet reaches a changed subpackage',
      /^sub\/s\.go:12 · vet\/printf · /m.test(o),
      o,
    );
  }
  if (!has('staticcheck')) console.log('skip  lint live staticcheck: not installed');
  else {
    check(
      'lint live: staticcheck U1000 on the new func only',
      /^main\.go:21 · staticcheck\/U1000 · func unusedNew is unused/m.test(o) &&
        !/unusedOld/.test(o),
      o,
    );
    check(
      'lint live: a style code (ST1005) is skipped and counted',
      !/ST1005/.test(o) && /^# staticcheck: [^\n]* · [1-9]\d* style findings skipped/m.test(o),
      o,
    );
    const kept = lint('--tools', 'staticcheck', '--style').stdout;
    check(
      'lint live: --style keeps it',
      /^sub\/s\.go:9 · staticcheck\/ST1005 · /m.test(kept),
      kept,
    );
  }
  if (!has('ruff')) console.log('skip  lint live ruff: not installed');
  else
    check(
      'lint live: ruff F401 on the added import only',
      /^lib\.py:2 · ruff\/F401 · /m.test(o) && !/^lib\.py:1 /m.test(o),
      o,
    );
  if (!has('semgrep')) console.log('skip  lint live semgrep: not installed');
  else
    check(
      'lint live: semgrep local rule on the added os.Exit only',
      /^main\.go:15 · semgrep\/test-os-exit · os\.Exit outside main wiring/m.test(o) &&
        !/^main\.go:12 · semgrep/m.test(o),
      o,
    );

  const bad = lint('--tools', 'semgrep', '--semgrep-config', path.join(root, 'no-such-rule.yaml'));
  check(
    'lint live: a failing tool is a header line, exit still 0',
    bad.status === 0 && /^# semgrep: failed — /m.test(bad.stdout),
    bad.stdout + bad.stderr,
  );
  check('lint: an unknown --tools name = exit 2', lint('--tools', 'eslint').status === 2);

  writeFileSync(path.join(dir, 'main.go'), goHead.replace('"new"', '"edited"'));
  const drift = lint('--tools', 'vet');
  check(
    'lint: a clone not at head = exit 2 (rows would point at the wrong lines)',
    drift.status === 2 && /not checked out at/.test(drift.stderr),
    `${drift.status} ${drift.stderr}`,
  );
  const all = spawnSync(
    process.execPath,
    [TOOL, 'all', '--repo', dir, '--base', base, '--no-install', '--tools', 'vet'],
    { encoding: 'utf8' },
  );
  check(
    'all: lint skipped with a note when the clone is not at head, exit 0',
    all.status === 0 && /^# lint: skipped — /m.test(all.stdout),
    all.stdout + all.stderr,
  );
  git(dir, 'checkout', '--', 'main.go');
  const noLint = spawnSync(
    process.execPath,
    [TOOL, 'all', '--repo', dir, '--base', base, '--no-lint'],
    { encoding: 'utf8' },
  );
  check(
    'all --no-lint: no lint section',
    noLint.status === 0 && !/## lint/.test(noLint.stdout) && /## knobs/.test(noLint.stdout),
    noLint.stdout,
  );
}

// A pathspec past the Windows command-line cap (32,767 chars) goes in batches: one `git diff -- <all>` there
// returned no stdout and diffLines read an empty diff (a 1494-file diff).
{
  const dirName = 'd'.repeat(90);
  const names = Array.from({ length: 400 }, (_, i) => `pkg/${dirName}/f${i}.go`);
  const b = Object.fromEntries(names.map((n, i) => [n, `package p\n\nconst V${i} = 1\n`]));
  const h = Object.fromEntries(names.map((n, i) => [n, `package p\n\nconst V${i} = 2\n`]));
  const { dir, base } = repo('long-pathspec', b, h);
  const d = S.diffLines(dir, base, 'HEAD', names);
  check(
    'long pathspec (400 paths, >40k chars): every file and added line read',
    d.files.size === 400 && d.added.length === 400,
    `${d.files.size} files, ${d.added.length} added`,
  );
}

console.log(`\n${pass} passed, ${fails.length} failed`);
if (fails.length) {
  for (const f of fails) console.log('  - ' + f);
  process.exit(1);
}
