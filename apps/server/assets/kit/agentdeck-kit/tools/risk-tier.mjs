#!/usr/bin/env node
// risk-tier — how much checking this change has earned, computed instead of felt.
//
// The failure this prevents is not "checked too little". It is the drift in both directions: a copy
// fix that drags a two-hour protocol behind it, and an RBAC change waved through on a glance because
// the diff was small. Effort follows BLAST RADIUS, never diff size — so the tier is decided by
// markers found in the change itself, each printed with the file that produced it.
//
//   node <kit>/tools/risk-tier.mjs [--base origin/main] [--cwd <dir>] [--json] [--no-radius]
//                                      [--paths <zone>[,<zone>…]] [--budget <seconds>]
//
// --paths narrows the CHANGE to one zone (a review lane); consumers are still searched repo-wide.
// --budget bounds the radius and string search (default 150 s); whatever it cuts is printed as unsearched.
// --no-radius skips the import radius only; consumers of removed lines are searched at every tier regardless.
//
// T0 glance · T1 standard (default) · T2 hard — any single marker lifts the whole change to T2.
//
// Depth is half of the answer. The other half is BREADTH: who else runs the code that changed. A
// review that reads only the diff and a live run that walks only the ticket's screen both miss the
// second screen rendering the same component — so the radius is computed here too, by the same
// command: from the changed files up through their importers to the entry points (screens, routes,
// handlers). Computed means bounded. The list has an end, the caps below are counted in its rows, and
// that is what keeps a global look from turning into an open-ended one.
import { spawnSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { dirname, basename, extname, join, posix } from 'node:path';

const argv = process.argv.slice(2);
const flag = (n, d = null) => {
  const i = argv.indexOf(`--${n}`);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : d;
};
const CWD = flag('cwd', process.cwd());
const AS_JSON = argv.includes('--json');
const WITH_RADIUS = !argv.includes('--no-radius');
const ZONE_ARG = (flag('paths') || '')
  .split(',')
  .map((s) => s.trim().replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, ''))
  .filter(Boolean);
const inZone = (f) => !ZONE_ARG.length || ZONE_ARG.some((z) => f === z || f.startsWith(`${z}/`));
const DEADLINE = Date.now() + Number(flag('budget', '150')) * 1000;

const git = (a) => spawnSync('git', a, { cwd: CWD, encoding: 'utf8', maxBuffer: 64 << 20 });
const root = git(['rev-parse', '--show-toplevel']).stdout?.trim();
if (!root) {
  console.error('risk-tier: not a git repository');
  process.exit(2);
}
const gitRoot = (a) => spawnSync('git', a, { cwd: root, encoding: 'utf8', maxBuffer: 64 << 20 });

function resolveBase() {
  const explicit = flag('base');
  if (explicit) return explicit;
  for (const ref of ['origin/main', 'origin/master', 'main', 'master']) {
    if (git(['rev-parse', '--verify', '--quiet', ref]).status === 0) {
      const mb = git(['merge-base', 'HEAD', ref]).stdout?.trim();
      if (!mb) continue;
      // A branch sitting ON the base has its work uncommitted; HEAD is then the honest base. The
      // first ref that exists DECIDES: falling through to the next one reached a local `main` nobody
      // had pulled for weeks and reported 137 changed files for a 13-file working copy.
      return mb === git(['rev-parse', 'HEAD']).stdout?.trim() ? 'HEAD' : mb;
    }
  }
  return 'HEAD';
}
const base = resolveBase();

// Committed work plus whatever is still in the tree: a review of a working copy must see both.
const diff = [
  gitRoot(['diff', `${base}...HEAD`]).stdout || '',
  gitRoot(['diff']).stdout || '',
  gitRoot(['diff', '--cached']).stdout || '',
].join('\n');

const files = new Set();
for (const m of diff.matchAll(/^\+\+\+ b\/(.+)$/gm))
  if (m[1] !== '/dev/null') files.add(m[1].trim());
// New files nobody staged yet are work too, and `git diff` cannot see them.
const untracked = (gitRoot(['ls-files', '--others', '--exclude-standard']).stdout || '')
  .split('\n')
  .map((s) => s.trim())
  .filter(Boolean);
for (const f of untracked) files.add(f);
// The whole change, before a zone narrows it: a consumer inside ANOTHER zone of the same change is
// still "in the diff", and the zones block describes all of it.
const allChanged = new Set(files);
for (const f of [...files]) if (!inZone(f)) files.delete(f);
if (ZONE_ARG.length && !files.size && allChanged.size) {
  console.error(
    `risk-tier: no changes inside zone ${ZONE_ARG.join(', ')} (the diff has ${allChanged.size} files) — check the path.`,
  );
  process.exit(2);
}

// An empty change set is the absence of a measurement, never a T0: a clean tree sitting on its base
// used to print "T0 · files 0", which reads as a verdict about a change nobody looked at.
if (!files.size) {
  if (AS_JSON)
    console.log(JSON.stringify({ tier: null, base, files: [], error: 'empty-diff' }, null, 2));
  else
    console.error(
      `risk-tier: empty diff (base ${base.slice(0, 12)}) — nothing to grade. The branch is already merged or the base is wrong: pass --base <ref>.`,
    );
  process.exit(2);
}

const slurped = new Map();
const slurp = (rel) => {
  if (slurped.has(rel)) return slurped.get(rel);
  let t = '';
  try {
    t = readFileSync(join(root, rel), 'utf8');
    if (t.length > 1_500_000) t = ''; // a bundle, not source; OpenAPI specs run to ~1 MB
  } catch {
    /* unreadable = empty */
  }
  slurped.set(rel, t);
  return t;
};

// The diff read per file: which lines were added (markers) and which line numbers moved (radius).
const addedBy = new Map(); // file → [text]
// A literal that LEFT the diff is the stronger coupling signal of the two: whoever still names the old
// key is now talking to nobody, and no import graph shows it.
const removedBy = new Map(); // file → [text]
const changedLines = new Map(); // file → Set(new-side line number)
{
  let cur = null;
  let n = 0;
  const mark = (k) => {
    if (!changedLines.has(cur)) changedLines.set(cur, new Set());
    changedLines.get(cur).add(k);
  };
  for (const l of diff.split('\n')) {
    if (l.startsWith('diff --git')) cur = null;
    else if (l.startsWith('+++ ')) cur = l.startsWith('+++ b/') ? l.slice(6).trim() : null;
    else if (!cur || l.startsWith('--- ')) continue;
    else {
      const h = /^@@ -\d+(?:,\d+)? \+(\d+)/.exec(l);
      if (h) n = Number(h[1]);
      else if (l.startsWith('+')) {
        if (!addedBy.has(cur)) addedBy.set(cur, []);
        addedBy.get(cur).push(l.slice(1));
        mark(n++);
      } else if (l.startsWith('-')) {
        if (!removedBy.has(cur)) removedBy.set(cur, []);
        removedBy.get(cur).push(l.slice(1));
        mark(n);
      } else if (l.startsWith(' ')) n++;
    }
  }
}
// An untracked file is all added lines; without this a brand-new auth module carries no marker.
const untrackedSet = new Set(untracked);
for (const f of untracked)
  if (/\.(ts|tsx|js|jsx|mjs|cjs|go|py|sql|ya?ml)$/i.test(f)) addedBy.set(f, slurp(f).split('\n'));

const SOURCE = /\.(ts|tsx|js|jsx|mjs|cjs|go|py|rb|java|kt|cs|rs|php|vue|svelte)$/i;
const IS_TEST =
  /[._-](test|spec)\.|_test\.go$|(^|[\\/])(test_[^\\/]+|conftest)\.py$|(^|[\\/])(tests?|__tests__|e2e)[\\/]/i;
const GENERATED = /(^|[\\/])(node_modules|dist|build|vendor|__generated__|sqlcdb)[\\/]|\.d\.ts$/i;
// Declarations only: nothing in a `types.ts` runs, so no test can go red over it, and demanding one
// lifted every typed change to T2. The type checker is its test. A project that hides runtime code in
// a file with this name is lying in the filename — a style finding, not a tier.
const DECLARATION_ONLY = /(^|[\\/])types\.tsx?$|\.types\.ts$/i;

// ---- markers -------------------------------------------------------------------------------------
// Each is a class of defect whose cost lands somewhere a test run cannot reach: another tenant's data,
// a customer's invoice, a migration that already ran. `where` names what produced it, so the verdict
// can be argued with instead of believed.
const KEYWORD_MARKERS = [
  [
    'access and ownership',
    /\b(rbac|casbin|permission|perm\(|RequirePermission|tenant|authoriz|authenticat|\bjwt\b|mTLS|session|refresh_token|is_admin|role[s]?\b)/i,
  ],
  [
    'money and counters',
    /\b(billing|invoice|price|amount|quota|usage|limit_|balance|charge|tokens_used|counter|aggregat|discount|refund|payment|payout|cents|tax|subtotal|currency)/i,
  ],
  ['schema and contract', /\b(ALTER TABLE|CREATE TABLE|DROP |migration|openapi|swagger|breaking)/i],
  [
    'concurrency',
    /\b(goroutine|sync\.|Mutex|async def|await Promise\.all|WebSocket|EventSource|stream|retry|debounce|invalidateQueries|refetch|race)/i,
  ],
  ['irreversible', /\b(DELETE FROM|TRUNCATE|\.delete\(|rmSync|unlink|purge|revoke|force)/i],
];
// Bounded on both sides: an unbounded `guard` made every file of the `guardrails` domain an access
// marker, so a whole product area sat at T2 by its name alone.
const ACCESS_PATH =
  /(^|[\\/])(auth(entication|orization|n|z|client)?|\w+-auth|security|rbac|guards?|middleware|permissions?)([\\/._-]|$)/i;
const SCHEMA_PATH = /(^|[\\/])(contracts|migrations?|db[\\/](schema|queries))[\\/]|\.sql$/i;
const PATH_MARKERS = [
  ['access and ownership', ACCESS_PATH],
  ['schema and contract', SCHEMA_PATH],
];

const markers = [];
const note = (why, where) => {
  if (!markers.some((m) => m.why === why)) markers.push({ why, where });
};

// A marker is a claim about what RUNS. A test or a page of prose that mentions `force` or `session`
// changes nothing that runs, and counting them lifted documentation changes to T2.
const riskBearing = (f) =>
  (files.has(f) && SOURCE.test(f) && !IS_TEST.test(f) && !GENERATED.test(f)) ||
  /\.(sql|proto|graphql)$/i.test(f) ||
  SCHEMA_PATH.test(f);
for (const [why, re] of PATH_MARKERS)
  for (const f of files) if (re.test(f) && !IS_TEST.test(f)) note(why, f);
for (const [why, re] of KEYWORD_MARKERS)
  for (const [f, lines] of addedBy) {
    const hit = riskBearing(f) && lines.find((l) => re.test(l));
    if (hit) {
      note(why, `${f}: + ${hit.trim().slice(0, 60)}`);
      break;
    }
  }

// A changed behaviour-bearing file with no test beside it: the one marker that is about the CHECK
// rather than the code, and the one most often missed — nothing goes red when this file is wrong.

// Every test path the repo tracks, taken once. A per-directory look would only ever see the
// tests-beside-code idiom (TS, Go) and would mark every Python or Java project T2 on its first run —
// a tier that is always T2 is a tier nobody reads.
// A test deleted in the working copy is still tracked, and counted as coverage it vouched for a file
// whose only test had just been removed — found by this tool's own fixture test going red.
const deleted = new Set(
  (gitRoot(['ls-files', '--deleted']).stdout || '').split('\n').map((s) => s.trim()),
);
const testPaths = (gitRoot(['ls-files']).stdout || '')
  .split('\n')
  .map((s) => s.trim())
  .filter((s) => s && IS_TEST.test(s) && !deleted.has(s));

/** Test paths grouped by the package they belong to — the first path segment of a monorepo entry. */
// At the root of a single-package repository that segment is a container, not a package — `src/`
// beside `tests/`, `lib/` beside `spec/`, Go's `internal/` — and grouping by it put every source file
// in a package that owned no test, so the whole change read as untested and sat at T2 for nothing.
// Those live in the root package ('') on both sides; a real monorepo entry keeps its own name.
const ROOT_CONTAINER = /^(src|lib|app|internal|pkg|cmd|tests?|spec|specs|__tests__|e2e)$/i;
const pkgOf = (p) => {
  const first = p.split('/')[0];
  return p.includes('/') && !ROOT_CONTAINER.test(first) ? first : '';
};
// What a test is NAMED after. `Thing/index.test.tsx` is named after its folder exactly as
// `Thing/index.tsx` is — compared by basename alone it is called `index` and matches nothing, which
// marked every change in a directory-per-unit repo (one monorepo: 1048 of 1249 tests) as untested and
// therefore T2. A `__tests__/` or `tests/` folder is a container, not a name: step over it.
const CONTAINER = /^(__tests__|tests?|spec|e2e)$/i;
const testLabel = (t) => {
  const parts = t.toLowerCase().split('/');
  const file = parts.pop();
  if (!/^index[._-]/.test(file)) return file;
  while (parts.length && CONTAINER.test(parts[parts.length - 1])) parts.pop();
  return `${parts.pop() ?? ''}.${file}`;
};
const testsByPkg = new Map();
for (const t of [...testPaths, ...untracked.filter((u) => IS_TEST.test(u))]) {
  const k = pkgOf(t);
  if (!testsByPkg.has(k)) testsByPkg.set(k, []);
  testsByPkg.get(k).push(testLabel(t));
}

function isUntested(f) {
  if (!SOURCE.test(f) || IS_TEST.test(f) || GENERATED.test(f) || DECLARATION_ONLY.test(f))
    return false;
  const stem = basename(f, extname(f));
  // A directory-per-unit layout (`useThing/index.ts`, `parsePriority/index.ts`) is named by its
  // folder, not by the file: `index` on its own matches everything and would mean nothing.
  const needle = (stem === 'index' ? basename(dirname(f)) : stem).toLowerCase();
  // Delimited, not substring: `main` must not be found inside `test_domain`, which is exactly how a
  // loose match turns "no test anywhere" into a confident "covered" — the direction that costs.
  // Scoped to the package for the same reason: two modules may both own a `config`.
  const token = new RegExp(`(^|[^a-z0-9])${needle.replace(/[^a-z0-9]/g, '.')}([^a-z0-9]|$)`);
  const covered = needle.length > 1 && (testsByPkg.get(pkgOf(f)) ?? []).some((b) => token.test(b));
  return !covered;
}
const untested = [...files].filter(isUntested);
if (untested.length)
  note(
    'code changes with no test beside it',
    `${untested[0]}${untested.length > 1 ? ` (+${untested.length - 1})` : ''}`,
  );

// ---- tier ------------------------------------------------------------------------------------------
const behaviour = [...files].filter(
  (f) => SOURCE.test(f) && !GENERATED.test(f) && !IS_TEST.test(f) && !DECLARATION_ONLY.test(f),
);
const tier = markers.length ? 'T2' : behaviour.length === 0 ? 'T0' : 'T1';

// ---- radius ----------------------------------------------------------------------------------------
// Breadth is paid for in rows, and the rows are capped per tier — the cap is the time budget. What
// falls past a cap is PRINTED as not covered; it is never dropped silently and never chased for hours.
const CAPS = {
  T0: { rows: 0, entries: 0 },
  T1: { rows: 12, entries: 3 },
  T2: { rows: 25, entries: 6 },
};
const MAX_HOPS = 4; // changed unit → section → form → page is three; one spare
const HUB = 25; // more importers than this is a library primitive: sampled, never walked whole
const HUB_SAMPLE = 3;
const MAX_CONSUMERS = 1500; // the search is one index lookup per symbol now; rows past the print cap live in --json

const JS = /\.(ts|tsx|js|jsx|mjs|cjs|vue|svelte)$/i;
const ENTRY_DIR_FE = /^(pages|routes|screens|views)$/i;
const ENTRY_DIR_BE = /^(handlers?|controllers?|routers?|api|cmd)$/i;
const UNIT_DIR =
  /^(components?|ui|hooks?|utils?|lib|model|api|constants?|types?|styles?|helpers?|sections?|widgets?|internal)$/i;
// `entities/x/api/` is a frontend data layer, not a route: `api` counts as an entry only off the JS side.
const entryIndex = (f) =>
  f.split('/').findIndex((s) => (JS.test(f) ? ENTRY_DIR_FE : ENTRY_DIR_BE).test(s));

/** The screen or route a file belongs to, or null. `pkg · domain/Page`, named by path, never by guess. */
function entryLabel(f) {
  const i = entryIndex(f);
  if (i < 0) return null;
  const parts = f.split('/');
  const tail = [];
  for (const seg of parts.slice(i + 1)) {
    if (UNIT_DIR.test(seg) || tail.length === 2) break;
    const isFile = /\.[a-z0-9]+$/i.test(seg);
    const name = isFile ? seg.replace(/(\.(test|spec))?\.[a-z0-9]+$/i, '') : seg;
    if (name !== 'index' && name !== 'main') tail.push(name);
    if (isFile) break;
  }
  if (!tail.length) return null;
  return i > 0 ? `${parts[0]} · ${tail.join('/')}` : tail.join('/');
}

const KEYWORD =
  /^(default|function|class|async|const|index|types?|styles?|props|state|config|constants?|utils?|helpers?|data|item|value|name|error|result|main|init|test)$/i;

/** Names a file offers to the rest of the repo — what an importer would have to mention. */
function exportsOf(f, text) {
  const names = new Set();
  if (JS.test(f)) {
    const decl =
      /^\s*export\s+(?:default\s+)?(?:declare\s+)?(?:abstract\s+)?(?:async\s+)?(?:function\*?|const|let|var|class|enum|type|interface)\s+([A-Za-z_$][\w$]*)/gm;
    for (const m of text.matchAll(decl)) names.add(m[1]);
    for (const m of text.matchAll(/^\s*export\s*(?:type\s*)?\{([^}]*)\}/gm))
      for (const part of m[1].split(',')) {
        const n = part
          .trim()
          .split(/\s+as\s+/)
          .pop()
          ?.trim();
        if (n) names.add(n);
      }
    for (const m of text.matchAll(/^\s*export\s+default\s+(?:\w+\()?\s*([A-Za-z_$][\w$]*)/gm))
      names.add(m[1]);
  } else if (/\.go$/i.test(f)) {
    for (const m of text.matchAll(/^func\s+(?:\([^)]*\)\s*)?([A-Z]\w*)\s*[([]/gm)) names.add(m[1]);
    for (const m of text.matchAll(/^type\s+([A-Z]\w*)\b/gm)) names.add(m[1]);
  } else if (/\.py$/i.test(f)) {
    for (const m of text.matchAll(/^(?:async\s+)?(?:def|class)\s+([A-Za-z]\w*)/gm)) names.add(m[1]);
  }
  return [...names].filter((n) => n.length >= 4 && !KEYWORD.test(n));
}

const TOP_DECL = {
  js: /^(?:export\s+)?(?:default\s+)?(?:declare\s+)?(?:abstract\s+)?(?:async\s+)?(?:function\*?|const|let|var|class|enum|type|interface)\s+([A-Za-z_$][\w$]*)/,
  go: /^(?:func\s+(?:\([^)]*\)\s*)?|type\s+|var\s+|const\s+)([A-Za-z_]\w*)/,
  py: /^(?:async\s+)?(?:def|class)\s+([A-Za-z_]\w*)/,
};
const family = (f) =>
  JS.test(f) ? 'js' : /\.go$/i.test(f) ? 'go' : /\.py$/i.test(f) ? 'py' : 'other';

/**
 * The exports a change actually reached. A file of thirty hooks with one of them edited has ONE
 * changed export, and walking the importers of all thirty reported 61 consumers for a change that had
 * 9. Each top-level declaration owns the lines down to the next one; a changed private helper counts
 * for every export whose body mentions it. Anything the line map cannot settle — an untracked file, a
 * change in the imports or the module header — falls back to every export: the wide answer is the
 * safe one when the narrow one cannot be proved.
 *
 * The helper chain is followed to its end: a changed `a` called by private `b` called by exported `C`
 * reaches `C` — one level only left `C` out and its consumers with it. Go and Python also return the
 * changed PRIVATE names in `privates`: a Go package spans files, and the sibling file calling the
 * helper is the consumer the file-local view cannot see.
 */
function changedExports(f, text) {
  const all = exportsOf(f, text);
  const lines = changedLines.get(f);
  const re = TOP_DECL[family(f)];
  let names = all;
  const privates = [];
  if (lines && re && !untrackedSet.has(f)) {
    const src = text.split('\n');
    const decls = [];
    src.forEach((l, i) => {
      const m = re.exec(l);
      if (!m) return;
      // The doc comment and the decorators above a declaration are ITS lines, not the tail of the
      // previous one: an edited JSDoc sent the radius after the wrong hook.
      let start = i;
      while (start > 0 && /^\s*(\/\/|\/\*|\*|#|@)/.test(src[start - 1])) start--;
      decls.push({ name: m[1], start: start + 1 });
    });
    decls.forEach((d, i) => (d.end = i + 1 < decls.length ? decls[i + 1].start - 1 : src.length));
    const touched = decls.filter((d) => [...lines].some((n) => n >= d.start && n <= d.end));
    const header = [...lines].some((n) => !decls.length || n < decls[0].start);
    if (touched.length && !header) {
      const hit = new Set(touched.map((d) => d.name));
      const word = (p) => new RegExp(`(^|[^\\w$])${p.replace(/\$/g, '\\$')}([^\\w$]|$)`);
      const bodies = decls.map((d) => src.slice(d.start - 1, d.end).join('\n'));
      for (let grew = true; grew;) {
        grew = false;
        const reach = [...hit].filter((n) => !all.includes(n)).map(word);
        decls.forEach((d, i) => {
          if (hit.has(d.name) || !reach.some((w) => w.test(bodies[i]))) return;
          hit.add(d.name);
          grew = true;
        });
      }
      const narrowed = all.filter((n) => hit.has(n));
      if (family(f) === 'go' || family(f) === 'py')
        for (const n of hit)
          if (!all.includes(n) && n.length >= 4 && !KEYWORD.test(n)) privates.push(n);
      if (narrowed.length) names = narrowed;
      else if (privates.length && family(f) === 'go') names = []; // package-scoped: its users are all found
    }
  }
  // A default export is imported under whatever name the importer likes — by convention, the folder.
  // Only for a unit folder: `hooks/index.ts` is a barrel, and `hooks` as a symbol matches the world.
  const folder = basename(dirname(f));
  if (
    family(f) === 'js' &&
    /^index\./i.test(basename(f)) &&
    /^\s*export\s+default\b/m.test(text) &&
    !UNIT_DIR.test(folder) &&
    !KEYWORD.test(folder)
  )
    names = [...new Set([...names, folder])];
  return { names, privates };
}

/** Every `import … from 'x'` / `export … from 'x'` / `import('x')` of a JS file. */
function importsOf(text) {
  const out = [];
  for (const m of text.matchAll(
    /(?:^|\n)\s*(?:import|export)\s+(?:type\s+)?([^'";]*?)\s*from\s*['"]([^'"]+)['"]/g,
  ))
    out.push({ names: m[1], source: m[2] });
  for (const m of text.matchAll(/(?:import|require)\(\s*['"]([^'"]+)['"]\s*\)/g))
    out.push({ names: '*', source: m[1] });
  return out;
}

const isBarrel = (f, text) =>
  JS.test(f) &&
  text
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split(/;|\n(?=\s*export\b)/)
    .map((s) => s.trim())
    .filter((s) => s && !s.startsWith('//'))
    .every((s) => /^export\s+(type\s+)?(\*|\{[^}]*\})(\s+as\s+\w+)?\s+from\s+['"]/.test(s));

const stripExt = (p) => p.replace(/\.[cm]?[jt]sx?$/i, '').replace(/\/index$/i, '');

/**
 * Does this import statement point at the origin file? A bare name match is not enough — two modules
 * may both export `Container` — so the SOURCE has to lead to the origin as well: a relative path that
 * resolves onto it or onto a barrel above it, the origin's own package by name, or an alias inside the
 * same package whose last segment is one of the origin's folders.
 */
function pointsAt(source, consumer, origin) {
  if (source.startsWith('.')) {
    const resolved = stripExt(posix.normalize(posix.join(posix.dirname(consumer), source)));
    const target = stripExt(origin);
    return target === resolved || target.startsWith(`${resolved}/`) || resolved === '.';
  }
  const segs = source.split('/').filter(Boolean);
  const originSegs = stripExt(origin).split('/');
  if (segs.some((s) => s === pkgOf(origin)) && pkgOf(origin) !== pkgOf(consumer)) return true;
  if (pkgOf(origin) !== pkgOf(consumer)) return false;
  const last = stripExt(segs.join('/')).split('/').pop();
  return originSegs.includes(last);
}

function accepts(consumer, text, sym, origin) {
  if (JS.test(consumer)) {
    const word = new RegExp(`(^|[^\\w$])${sym.replace(/\$/g, '\\$')}([^\\w$]|$)`);
    return importsOf(text).some(
      (im) =>
        pointsAt(im.source, consumer, origin) &&
        (word.test(im.names) || (/\*/.test(im.names) && text.includes(`.${sym}`))),
    );
  }
  if (dirname(consumer) === dirname(origin)) return true; // same Go package / Python module folder
  const unit = /^(__init__|index|main)$/i.test(basename(origin, extname(origin)))
    ? basename(dirname(origin))
    : basename(origin, extname(origin));
  const folder = basename(dirname(origin));
  // A folder NAME is not an import: every Go service has an `internal/db`, and matching on `db` sent
  // thirteen `cp-*/main.go` into the radius of an `inst-admin-api` change (!778). Go is matched on the
  // exact import path from go.mod, Python on the dotted module; the name rule stays only inside a package.
  if (family(origin) === 'go') {
    const ip = goImportPath(dirname(origin));
    if (ip) return text.includes(`"${ip}"`);
  }
  if (family(origin) === 'py') {
    const mod = pyModule(origin);
    const esc = (s) => s.replace(/[.$]/g, (c) => `\\${c}`);
    const parent = mod.split('.').slice(0, -1).join('.');
    const direct = new RegExp(
      `(^|\\n)\\s*(from\\s+${esc(mod)}(\\s|\\.)|import\\s+${esc(mod)}\\b)`,
    ).test(text);
    const viaParent =
      parent &&
      [
        ...text.matchAll(
          new RegExp(`(?:^|\\n)\\s*from\\s+${esc(parent)}\\s+import\\s+(\\([^)]*\\)|[^\\n]*)`, 'g'),
        ),
      ].some((m) => new RegExp(`\\b${unit}\\b`).test(m[1]));
    if (direct || viaParent || pkgOf(origin) !== pkgOf(consumer))
      return Boolean(direct || viaParent);
  }
  return new RegExp(`(import|from)[^\\n]*\\b(${unit}|${folder})\\b|"[^"\\n]*/${folder}"`).test(
    text,
  );
}

const goMods = new Map(); // dir → import path | null
/** The Go import path of a directory: nearest go.mod's module line plus the path below it. */
function goImportPath(dir) {
  if (goMods.has(dir)) return goMods.get(dir);
  let ip = null;
  for (let d = dir; ; d = posix.dirname(d)) {
    const gm = join(root, d, 'go.mod');
    if (existsSync(gm)) {
      const m = /^module\s+(\S+)/m.exec(readFileSync(gm, 'utf8'));
      if (m) ip = d === dir ? m[1] : `${m[1]}/${d === '.' ? dir : dir.slice(d.length + 1)}`;
      break;
    }
    if (d === '.' || d === '' || posix.dirname(d) === d) break;
  }
  goMods.set(dir, ip);
  return ip;
}

/** `mod-x/src/pkg/api/check.py` → `pkg.api.check`: the name an importer writes. */
function pyModule(f) {
  const segs = f.replace(/\.py$/i, '').split('/');
  const i = segs.lastIndexOf('src');
  const mod = i >= 0 ? segs.slice(i + 1) : segs.slice(pkgOf(f) ? 1 : 0);
  if (mod[mod.length - 1] === '__init__') mod.pop();
  return mod.join('.');
}

// Who mentions a symbol, answered from ONE pass over the repo: every source file split into identifiers
// once, then each hop is a lookup. `git grep -w -o -F -f` over a symbol list cost ~0.5 s per symbol on
// a 984-file change (!778: 211 of 219 s), so the list was cut at 400 and the 802 symbols past the cut —
// the secrets scanner the chat also runs among them — were never searched, and nothing said so.
// The same index answers the string and HTTP searches: a literal is looked up through its rarest
// identifier, then confirmed with indexOf in that handful of files.
const INDEX_EXT =
  /\.(ts|tsx|js|jsx|mjs|cjs|vue|svelte|go|py|json|ya?ml|sql|css|scss|less|html|tmpl)$/i;
let tokenIndex = null; // identifier → [file]
const indexedFiles = [];
function buildTokenIndex() {
  const idx = new Map();
  const listed = (
    gitRoot(['ls-files', '--cached', '--others', '--exclude-standard']).stdout || ''
  ).split('\n');
  for (const raw of listed) {
    const f = raw.trim();
    if (!f || !INDEX_EXT.test(f) || GENERATED.test(f) || LOCKFILE.test(f) || deleted.has(f))
      continue;
    indexedFiles.push(f);
    const seen = new Set();
    for (const m of slurp(f).matchAll(/[A-Za-z_$][\w$]*/g)) {
      const t = m[0];
      if (t.length < 4 || seen.has(t)) continue;
      seen.add(t);
      if (!idx.has(t)) idx.set(t, []);
      idx.get(t).push(f);
    }
  }
  return idx;
}

function grepSymbols(symbols) {
  tokenIndex ??= buildTokenIndex();
  const hits = new Map(); // file → Set(symbol)
  for (const s of symbols)
    for (const f of tokenIndex.get(s) ?? []) {
      if (!hits.has(f)) hits.set(f, new Set());
      hits.get(f).add(s);
    }
  return hits;
}

const WORDCH = /[A-Za-z0-9_]/;
/**
 * Files containing `lit`. `word` = git grep -w: the match starts after a non-word character and ends
 * before one. Without it (a URL path inside a longer URL) only identifiers delimited INSIDE the
 * literal may anchor the lookup, since the literal's edges can fall mid-identifier in the file.
 */
function filesWith(lit, word) {
  tokenIndex ??= buildTokenIndex();
  let pool = null;
  for (const m of lit.matchAll(/[A-Za-z_$][\w$]*/g)) {
    const inner = m.index > 0 && m.index + m[0].length < lit.length;
    if (m[0].length < 4 || !(word || inner)) continue;
    const l = tokenIndex.get(m[0]) ?? [];
    if (!pool || l.length < pool.length) pool = l;
    if (!l.length) break;
  }
  const out = [];
  for (const f of pool ?? indexedFiles) {
    const t = slurp(f);
    for (let i = t.indexOf(lit); i >= 0; i = t.indexOf(lit, i + 1))
      if (!word || ((i === 0 || !WORDCH.test(t[i - 1])) && !WORDCH.test(t[i + lit.length] ?? ''))) {
        out.push(f);
        break;
      }
  }
  return out;
}

/**
 * Rows in the order a capped reader should take them: OUTSIDE the diff first — the dependant nobody
 * edited is where a regression hides, and the author already looked at the rest — then nearest hop,
 * then round-robin over packages so a third sibling next door never displaces another package.
 */
function breadthOrder(rows, keyOf) {
  const groups = new Map();
  for (const r of rows) {
    const k = keyOf(r);
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(r);
  }
  const out = [];
  for (const k of [...groups.keys()].sort()) {
    const byPkg = new Map();
    for (const r of groups.get(k).sort((a, b) => a.file.localeCompare(b.file))) {
      const p = pkgOf(r.file);
      if (!byPkg.has(p)) byPkg.set(p, []);
      byPkg.get(p).push(r);
    }
    const queues = [...byPkg.values()];
    for (let i = 0, left = groups.get(k).length; left > 0; i++)
      for (const q of queues)
        if (q[i]) {
          out.push(q[i]);
          left--;
        }
  }
  return out;
}

function computeRadius() {
  const consumers = new Map(); // file → { hop, via, sym, inDiff }
  const tests = new Set();
  const hubs = [];
  let truncated = false;
  let stopped = null; // { hop, reason, pending } — the walk ended with files still owed a search
  let frontier = behaviour.filter((f) => existsSync(join(root, f)));
  const seen = new Set(frontier);

  for (let hop = 1; frontier.length && !truncated; hop++) {
    if (hop > MAX_HOPS) {
      stopped = { hop, reason: `stopped deeper than ${MAX_HOPS} hops`, pending: frontier.length };
      break;
    }
    if (Date.now() > DEADLINE) {
      stopped = { hop, reason: 'time budget exhausted (--budget)', pending: frontier.length };
      break;
    }
    const owners = new Map(); // symbol → [origin]
    const privateSyms = new Set();
    const own = (s, f) => {
      if (!owners.has(s)) owners.set(s, []);
      owners.get(s).push(f);
    };
    for (const f of frontier) {
      // Hop 1 asks who uses what CHANGED; from hop 2 on the consumer itself is unchanged, so whatever
      // it exports may carry the change outward.
      if (hop > 1) {
        for (const s of exportsOf(f, slurp(f))) own(s, f);
        continue;
      }
      const { names, privates } = changedExports(f, slurp(f));
      for (const s of names) own(s, f);
      for (const s of privates) {
        own(s, f);
        privateSyms.add(s);
      }
    }
    // --explain: which symbols each hop went looking for, so a row can be argued with.
    if (argv.includes('--explain'))
      for (const [s, o] of owners) console.error(`hop ${hop}: ${s}  ← ${o.join(', ')}`);
    if (!owners.size) break;

    const found = new Map(); // origin → [{ file, sym }]
    for (const [file, syms] of grepSymbols([...owners.keys()])) {
      if (!SOURCE.test(file)) continue;
      const text = slurp(file);
      // A pure barrel is a pipe, not a consumer. The search is by NAME, so it already sees through it
      // to whoever imports the symbol; expanding the barrel instead sends every sibling it re-exports
      // outward, and two unrelated screens arrived in the radius that way.
      if (isBarrel(file, text)) continue;
      for (const sym of syms)
        for (const origin of owners.get(sym) ?? []) {
          // An import never crosses a language: Go reaches a TS change through an endpoint string,
          // which the last line of the report sends to grep, not through a symbol called `hooks`.
          if (origin === file || family(origin) !== family(file)) continue;
          if (
            privateSyms.has(sym)
              ? dirname(file) !== dirname(origin)
              : !accepts(file, text, sym, origin)
          )
            continue;
          if (!found.has(origin)) found.set(origin, []);
          if (!found.get(origin).some((c) => c.file === file))
            found.get(origin).push({ file, sym });
        }
    }

    const next = [];
    for (const [origin, list] of found) {
      const code = list.filter((c) => !IS_TEST.test(c.file));
      for (const c of list) if (IS_TEST.test(c.file)) tests.add(c.file);
      if (code.length > HUB) {
        // The packages are named: severity is the worst over every consumer, and a hub's consumers
        // are exactly the products that finding lands in.
        const pkgList = [...new Set(code.map((c) => pkgOf(c.file) || '(root)'))].sort();
        hubs.push({ file: origin, consumers: code.length, packages: pkgList.length, pkgList });
        continue;
      }
      for (const c of code) {
        if (consumers.has(c.file) || (seen.has(c.file) && hop > 1)) continue;
        consumers.set(c.file, { hop, via: origin, sym: c.sym, inDiff: allChanged.has(c.file) });
        if (consumers.size >= MAX_CONSUMERS) {
          truncated = true;
          stopped = { hop, reason: `cap of ${MAX_CONSUMERS} consumers`, pending: code.length };
        }
        if (!seen.has(c.file)) {
          seen.add(c.file);
          next.push(c.file);
        }
      }
    }
    frontier = next;
  }

  // Entry points: every file in the radius that sits under a screen or a route, the changed ones
  // included — a page edited directly is its own entry at hop 0.
  const entries = new Map(); // label → { hop, file, chain }
  const chainOf = (f) => {
    const chain = [];
    for (let cur = f, guard = 0; consumers.has(cur) && guard < 8; guard++) {
      const c = consumers.get(cur);
      chain.push(c.sym);
      cur = c.via;
    }
    return chain;
  };
  for (const f of behaviour) {
    const label = entryLabel(f);
    if (label && !entries.has(label)) entries.set(label, { hop: 0, file: f, chain: [] });
  }
  for (const [f, c] of consumers) {
    const label = entryLabel(f);
    if (label && (!entries.has(label) || entries.get(label).hop > c.hop))
      entries.set(label, { hop: c.hop, file: f, chain: chainOf(f) });
  }

  // Order of the walk under a cap: closest first, then round-robin over packages — so the consumer in
  // ANOTHER package is never the one dropped in favour of a third sibling next door.
  const byPkg = new Map();
  for (const [label, e] of [...entries].sort(
    (a, b) => a[1].hop - b[1].hop || a[0].localeCompare(b[0]),
  )) {
    const k = pkgOf(e.file);
    if (!byPkg.has(k)) byPkg.set(k, []);
    byPkg.get(k).push({ label, ...e });
  }
  const ordered = [];
  for (let i = 0; ordered.length < entries.size; i++)
    for (const q of byPkg.values()) if (q[i]) ordered.push(q[i]);

  return {
    consumers: breadthOrder(
      [...consumers].map(([file, c]) => ({ file, ...c })),
      (r) => `${r.inDiff ? 1 : 0}.${String(r.hop).padStart(2, '0')}`,
    ),
    entries: ordered,
    hubs,
    tests: [...tests].sort(),
    truncated,
    stopped,
  };
}

// ---- string coupling ---------------------------------------------------------------------------
// Everything that travels between modules as TEXT is invisible to the import graph: an endpoint, a
// query key, an i18n key, an event or channel name, a permission, a feature flag, a CSS class or
// custom property. review-depth.md sent these to a manual grep — the one radius step with no tool, so
// the one nobody ran. This executes it: literals the diff added or removed, looked up repo-wide.
//
// The filter is SCARCITY, not a vocabulary of what a key looks like. A literal nothing else mentions
// is not a coupling; one that forty files mention is vocabulary. What is left — a handful of files
// sharing an exact string with the change — is the set worth a verdict row, and it stays language-
// and framework-agnostic because it never guesses at meaning.
const STR_MAX_FILES = 10; // in more files than this it is vocabulary, not a coupling
const STR_ROWS = 8;
const LOCKFILE = /(^|[\\/])(package-lock\.json|yarn\.lock|pnpm-lock\.yaml|go\.sum|poetry\.lock)$/i;
const LITERAL = /(['"`])((?:\\.|(?!\1)[^\\\r\n])*)\1/g;

/** Is this literal worth asking the repository about? */
function couplingCandidate(s) {
  if (s.length < 4 || s.length > 80) return false;
  if (/\s/.test(s)) return false; // a sentence is a message to a human, not a key between modules
  if (!/[A-Za-z]/.test(s)) return false;
  if (/^\.{1,2}\//.test(s)) return false; // relative import specifier
  if (/^#[0-9a-fA-F]{3,8}$/.test(s)) return false; // a colour is not a coupling
  if (/^[{<][\w.-]+[}>]$/.test(s)) return false; // `{file}` is a placeholder, not a value
  if (/\.(tsx?|jsx?|mjs|cjs|vue|svelte|go|py|css|scss)$/i.test(s)) return false; // a module path
  // A separator is what makes a bare word a key; without one, only a long name earns the grep.
  return /[./:_-]/.test(s) || s.length >= 6;
}

// Scarcity cuts the other way for a NEW literal a producer emits: an error code, a contract field or
// enum member that nothing outside the change names is a code with no reader — the client that should
// map it was never touched. Only producer-shaped additions qualify (a contract/spec file, or a line
// that builds an error); a new CSS class or test id with no outside mention is ordinary.
const PRODUCER_FILE =
  /(^|[\\/])(contracts?|openapi|swagger|schemas?|api-?spec)([\\/._-]|$)|(^|[\\/])(errors?|error_?codes?|codes?)\.(go|py|ts|js|mjs)$/i;
const ERROR_LINE =
  /\b(errors?\.(New|Wrap\w*)|fmt\.Errorf|raise|throw|new\s+\w*(Error|Exception))\b|\w(Error|Exception)\s*\(|\b(error_?code|errorCode|err_?code|code|reason)["']?\s*[:=]/i;
const KEY_SHAPE = /[._:-]|^[A-Z][A-Z0-9]{5,}$/; // a separator, or a SCREAMING code like FORBIDDEN

/** Literals the diff added or removed, deduped; producers = added in a producer position → files. */
function changedLiterals() {
  const out = new Set();
  const producers = new Map();
  for (const map of [addedBy, removedBy])
    for (const [f, lines] of map) {
      if (!files.has(f) || GENERATED.test(f)) continue;
      const producerFile =
        map === addedBy && !IS_TEST.test(f) && (PRODUCER_FILE.test(f) || SCHEMA_PATH.test(f));
      for (const raw of lines) {
        const line = raw.trim();
        // An import line's literal is a path the graph already walked, and a comment is not code.
        if (/^(import|from|require|package|use)\b/.test(line) || /^(\/\/|\/\*|\*|#)/.test(line))
          continue;
        const producerLine =
          producerFile || (map === addedBy && !IS_TEST.test(f) && ERROR_LINE.test(line));
        for (const m of line.matchAll(LITERAL)) {
          const s = m[2];
          if (s.includes('${')) continue; // an interpolated template is a shape, not a value
          if (!couplingCandidate(s)) continue;
          out.add(s);
          if (producerLine && KEY_SHAPE.test(s)) {
            if (!producers.has(s)) producers.set(s, new Set());
            producers.get(s).add(f);
          }
        }
      }
    }
  // Producers first: past the candidate cap an unscanned literal would read as «named nowhere».
  return { cands: [...new Set([...producers.keys(), ...out])], producers };
}

function computeStrings() {
  const { cands, producers } = changedLiterals();
  if (!cands.length) return { scanned: 0, couplings: [], unconsumed: [], overflow: 0 };
  const hits = new Map(); // literal → Set(file)
  // Every literal, under the shared deadline: past it the rest is COUNTED as unsearched — a cut list
  // once read as «nowhere else» for literals never looked up.
  const use = [];
  for (const lit of cands) {
    if (use.length && Date.now() > DEADLINE) break;
    use.push(lit);
    const where = filesWith(lit, true); // -w semantics: `l.agent.md` must not match inside `tool.agent.md`
    if (where.length) hits.set(lit, new Set(where));
  }
  const couplings = [];
  for (const [lit, where] of hits) {
    const others = [...where].filter((f) => !files.has(f)).sort();
    if (!others.length || others.length > STR_MAX_FILES) continue;
    couplings.push({ literal: lit, files: others });
  }
  // Scarcest first: the fewer places share an exact string, the more certain the coupling is real.
  couplings.sort((a, b) => a.files.length - b.files.length || a.literal.localeCompare(b.literal));
  const scanned = new Set(use);
  const unconsumed = [];
  for (const [lit, srcs] of producers) {
    if (!scanned.has(lit)) continue;
    const where = [...(hits.get(lit) ?? [])];
    if (where.some((f) => !files.has(f))) continue;
    // A reader inside the same change is still a reader: named, so the verdict row is one glance.
    const inDiff = where.filter((f) => !srcs.has(f) && !IS_TEST.test(f)).sort();
    unconsumed.push({ literal: lit, addedIn: [...srcs].sort(), inDiff });
  }
  unconsumed.sort(
    (a, b) => a.inDiff.length - b.inDiff.length || a.literal.localeCompare(b.literal),
  );
  return {
    scanned: use.length,
    couplings,
    unconsumed,
    overflow: Math.max(0, cands.length - use.length),
  };
}

const radius = WITH_RADIUS && tier !== 'T0' ? computeRadius() : null;
const strings = WITH_RADIUS && tier !== 'T0' ? computeStrings() : null;

// ---- consumers over HTTP -------------------------------------------------------------------------
// A service is consumed by URL, not by import. !778 changed the secrets scanner behind
// `/v1/scan/input`; the chat, the image module and the shared guard all call that route, and not one
// import leads to them — so the finding was rated for the admin screen alone. Routes declared in any
// file the change reaches (diff or radius) are looked up in OTHER packages.
const ROUTE_DECL = [
  /@\w+\.(?:get|post|put|patch|delete|route|websocket|api_route)\(\s*[rf]?["']([^"'\n]+)["']/gi, // FastAPI / Flask
  /\.(?:HandleFunc|Handle|GET|POST|PUT|PATCH|DELETE|Get|Post|Put|Patch|Delete|Any|Route|Method)\(\s*"([^"\n]+)"/g, // Go routers
  /@(?:Get|Post|Put|Patch|Delete|All)\(\s*['"]([^'"\n]+)['"]/g, // Nest
  /\b(?:router|app|server|r|mux)\.(?:get|post|put|patch|delete|all|route)\(\s*['"`]([^'"`\n]+)['"`]/g, // express / fastify
];
const ROUTE_GENERIC =
  /^\/?(health|healthz|ready|readyz|live|livez|metrics|ping|status|version|docs|openapi\.json)?\/?$/i;
const HTTP_MAX_FILES = 15; // mentioned in more files than this, a path is vocabulary
const HTTP_ROWS = 8;

/** The searchable part of a declared route, or null when it is too generic to mean one endpoint. */
function routePiece(declared) {
  const route = declared.replace(/^[A-Z]+\s+/, '').trim();
  if (!route.startsWith('/') || ROUTE_GENERIC.test(route)) return null;
  // The longest run without a parameter: callers write the params their own way.
  const piece = route
    .split(/\{[^}]*\}|<[^>]*>|:\w+|\*/)
    .map((s) => s.replace(/\/+$/, ''))
    .sort((a, b) => b.length - a.length)[0];
  // One bare segment (`/batch`, `/trends`) is vocabulary: it matched nine packages on !778.
  const segs = (piece ?? '').split('/').filter(Boolean).length;
  if (
    !piece ||
    !/[a-z]/i.test(piece) ||
    ROUTE_GENERIC.test(piece) ||
    (segs < 2 && piece.length < 12)
  )
    return null;
  return { route, piece };
}

function computeHttp() {
  const owners = new Map(); // piece → { route, owner }
  const sources = new Set([...behaviour, ...(radius?.consumers ?? []).map((c) => c.file)]);
  for (const f of sources) {
    if (!SOURCE.test(f) || IS_TEST.test(f)) continue;
    const text = slurp(f);
    for (const re of ROUTE_DECL)
      for (const m of text.matchAll(re)) {
        const rp = routePiece(m[1]);
        if (rp && !owners.has(rp.piece)) owners.set(rp.piece, { route: rp.route, owner: f });
      }
  }
  const pieces = [...owners.keys()];
  if (!pieces.length) return { routes: 0, rows: [], overflow: 0 };
  const hits = new Map(); // piece → Set(file)
  let searched = 0;
  for (const piece of pieces) {
    if (searched && Date.now() > DEADLINE) break;
    searched++;
    const where = filesWith(piece, false);
    if (where.length) hits.set(piece, new Set(where));
  }
  const rows = [];
  for (const [piece, where] of hits) {
    const o = owners.get(piece);
    if (!o) continue;
    const foreign = [...where].filter((f) => pkgOf(f) !== pkgOf(o.owner)).sort();
    if (!foreign.length || foreign.length > HTTP_MAX_FILES) continue;
    const code = foreign.filter((f) => !IS_TEST.test(f));
    if (!code.length) continue;
    rows.push({
      route: o.route,
      owner: o.owner,
      packages: [...new Set(code.map((f) => pkgOf(f) || '(root)'))].sort(),
      files: code,
      tests: foreign.length - code.length,
    });
  }
  // Rows reaching the most other packages first: that is where the worst consumer hides.
  rows.sort((a, b) => b.packages.length - a.packages.length || a.route.localeCompare(b.route));
  return { routes: pieces.length, rows, overflow: pieces.length - searched };
}
const http = WITH_RADIUS && tier !== 'T0' ? computeHttp() : null;

// ---- consumers of changed LINES ------------------------------------------------------------------
// The radius walks the importers of what a file offers NOW. A name the change removed or renamed is
// gone from the file, so nobody asks who still calls it — and neither does anyone ask which spec still
// clicks a removed test id, which QA script still requests a removed route, which screen still
// translates a removed i18n key. "Consumers outside the diff" was the class behind three MR blockers.
// Tokens come from REMOVED lines only and are dropped when the change offers them again (an edited or
// moved declaration); what is left goes through ONE bounded `git grep -F` over the working tree,
// tests / e2e / QA included — the consumers no import graph reaches. Runs at every tier: an i18n file
// is not behaviour-bearing, and a key removed from it is still a broken screen. It runs under
// `--no-radius` too — it needs no import graph, and the diffs too big for the radius are the ones
// most likely to drop a name somebody still reads.
const LINE_TOKENS_MAX = 60;
const LINE_ROWS = 10;
const QA_PATH =
  /(^|\/)(__tests__|tests?|e2e|qa|spec|specs|cypress|playwright)\/|[._-](test|spec)\.[^/]+$/i;
const I18N_PATH = /(^|\/)(i18n|locales?|langs?|translations?)(\/|[._-]|$)/i;
const I18N_EXT = /\.(json|[cm]?[jt]s|ya?ml)$/i;
// Names too generic to point at one declaration: a grep for them returns the vocabulary, not callers.
const COMMON_NAME =
  /^(default|function|class|async|const|index|types?|styles?|props|state|config|constants?|utils?|helpers?|data|item|items|value|values|name|error|errors|result|main|init|test|handler|render|children|title|label|options|params|query|model|schema|store|context|provider|component|button|input|client|server|router|routes?|service|request|response|payload|module|exports|string|number|boolean|object|array|promise|window|document|element|events?|list|user|users|text|keys?|setup|start|stop|load|save|update|create|delete|remove|reset|clear|close|open|next|prev|size|width|height|color|style|theme|layout|header|footer|content|message|status|state|mode|kind|path|file|files|url|link|image|icon|table|form|field|fields|filter|sort|page|pages|view|views)$/i;
const TEST_ID_ATTR =
  /\b(?:data-testid|data-test-id|data-test|data-qa|data-cy|testID|testId)\s*[=:]\s*\{?\s*["'`]([\w:.-]{4,})["'`]/g;
const FE_ROUTE = [
  /\bpath\s*[:=]\s*\{?\s*['"`](\/[^'"`\s]+)['"`]/g,
  /<Route\b[^>]*\bpath=\{?\s*["'`](\/[^"'`]+)["'`]/g,
];

/** Removed lines per OLD path — deleted files included, which the per-file maps above never see. */
function removedByOldPath() {
  const out = new Map();
  let path = null;
  let header = false;
  for (const l of diff.split('\n')) {
    if (l.startsWith('diff --git')) {
      header = true;
      path = null;
    } else if (header && l.startsWith('--- '))
      path = l.startsWith('--- a/') ? l.slice(6).trim() : null;
    else if (l.startsWith('@@')) header = false;
    // Inside a hunk `--- x` is a removed line whose text starts with `-- ` (an SQL comment), not a header.
    else if (!header && path && l.startsWith('-')) {
      if (!out.has(path)) out.set(path, []);
      out.get(path).push(l.slice(1));
    }
  }
  return out;
}

/**
 * The content of each path at the base, in ONE `git cat-file --batch` — a spawn per file cost ~25 ms on
 * Windows, a minute on a 2 000-file change. Sizes are bytes, so the output is parsed as a Buffer.
 */
function baseContents(paths) {
  const out = new Map();
  if (!paths.length) return out;
  // The diff is `base...HEAD`, so its old side is the merge-base — with `--base origin/main` the tip would
  // add main's own later keys and exports as phantom removals.
  const from =
    base === 'HEAD' ? 'HEAD' : gitRoot(['merge-base', base, 'HEAD']).stdout?.trim() || base;
  const r = spawnSync('git', ['cat-file', '--batch'], {
    cwd: root,
    input: paths.map((p) => `${from}:${p}`).join('\n') + '\n',
    maxBuffer: 256 << 20,
  });
  const buf = r.stdout;
  if (!buf || r.status !== 0) return out;
  let at = 0;
  for (const p of paths) {
    const nl = buf.indexOf(10, at);
    if (nl < 0) break;
    const head = buf.toString('utf8', at, nl);
    at = nl + 1;
    const m = /^\S+ (\w+) (\d+)$/.exec(head);
    if (!m) continue; // `<name> missing`: the file is new, it had no old content
    const size = Number(m[2]);
    if (m[1] === 'blob') out.set(p, buf.toString('utf8', at, at + size));
    at += size + 1;
  }
  return out;
}

/**
 * Every key path of a JSON / JS-object / YAML dictionary, dotted, leaves only. Brace or indent tracking,
 * not a parser: a dictionary file is a tree of `key: value` lines, and a heuristic that reads that shape
 * needs no build step and survives TS types around it. A leading locale segment (`en.orders.title`) is
 * dropped — the caller writes `orders.title`.
 */
function keyPaths(text, yaml) {
  const out = new Set();
  const add = (segs) => {
    const s = segs.filter(Boolean);
    if (s.length > 1 && /^[a-z]{2}([-_][A-Za-z]{2})?$/.test(s[0])) s.shift();
    if (s.length) out.add(s.join('.'));
  };
  const KEY = /^\s*(?:"([^"\n]+)"|'([^'\n]+)'|([A-Za-z_$][\w$-]*))\s*:(?!:)\s*(.*)$/;
  if (yaml) {
    const stack = []; // { key, indent }
    for (const raw of text.split('\n')) {
      if (!raw.trim() || /^\s*(#|-\s)/.test(raw)) continue;
      const m = KEY.exec(raw);
      if (!m) continue;
      const indent = raw.length - raw.trimStart().length;
      while (stack.length && stack[stack.length - 1].indent >= indent) stack.pop();
      const key = m[1] ?? m[2] ?? m[3];
      const rest = m[4].replace(/\s+#.*$/, '').trim();
      if (!rest) stack.push({ key, indent });
      else add([...stack.map((s) => s.key), key]);
    }
    return out;
  }
  const stack = []; // key per open brace, '' for an anonymous one
  for (const raw of text.split('\n')) {
    // Braces inside strings and comments are text, not structure.
    const bare = raw.replace(/(['"`])(?:\\.|(?!\1)[^\\])*\1/g, '""').replace(/\/\/.*$/, '');
    const opens = (bare.match(/\{/g) ?? []).length;
    const closes = (bare.match(/\}/g) ?? []).length;
    const m = KEY.exec(raw);
    const key = m && (m[1] ?? m[2] ?? m[3]);
    if (key && /^\{/.test(m[4].trim()) && opens > closes) {
      stack.push(key);
      for (let i = 1; i < opens - closes; i++) stack.push('');
      continue;
    }
    if (key) add([...stack, key]);
    for (let i = 0; i < opens - closes; i++) stack.push('');
    for (let i = 0; i < closes - opens; i++) stack.pop();
  }
  return out;
}

function computeLineConsumers() {
  const removed = removedByOldPath();
  // Everything the whole change (not only the zone) offers again: an edited or moved line is not a
  // removal, and a test id rendered by a new line is still rendered.
  const offeredIds = new Set();
  const addedText = [];
  for (const [f, lines] of addedBy)
    for (const l of lines) {
      if (!QA_PATH.test(f)) for (const m of l.matchAll(TEST_ID_ATTR)) offeredIds.add(m[1]);
      addedText.push(l);
    }
  const added = addedText.join('\n');

  const producers = [...removed.keys()].filter(
    (f) => inZone(f) && !GENERATED.test(f) && !LOCKFILE.test(f) && !QA_PATH.test(f),
  );
  const isDict = (f) => I18N_PATH.test(f) && I18N_EXT.test(f);
  // Names and keys are compared as whole sets, old file against new: a line diff cannot tell a removed
  // export from one that moved into a multi-line `export { … }` list, and a key's path is never on its line.
  const olds = baseContents(
    producers.filter((f) => (SOURCE.test(f) && family(f) !== 'other') || isDict(f)),
  );
  const nowText = (f) => (existsSync(join(root, f)) ? slurp(f) : '');

  // Every key the change's dictionaries hold now, the new sibling modules included — a key that moved
  // from `en.ts` into `en/groups.ts` is written there without its `groups.` prefix. Each key keeps the
  // files holding it: a suffix match counts only from a module that names the dropped namespace.
  const keysNow = new Map(); // key → [file]
  const squash = (s) => s.toLowerCase().replace(/[^a-z0-9]/g, '');
  const hintOf = new Map(); // file → its path + exported names, squashed: where a namespace is named
  for (const f of allChanged)
    if (isDict(f)) {
      const text = nowText(f);
      hintOf.set(
        f,
        squash(f) +
          '|' +
          [...text.matchAll(/\bexport\s+(?:const|let|var|default)\s+(\w+)/g)]
            .map((m) => squash(m[1]))
            .join('|'),
      );
      for (const k of keyPaths(text, /\.ya?ml$/i.test(f))) {
        if (!keysNow.has(k)) keysNow.set(k, []);
        keysNow.get(k).push(f);
      }
    }
  const PLURAL = /_(zero|one|two|few|many|other)$/;
  // Suffix lookups, not a scan: two 5 000-key dictionaries compared pairwise cost 7 s. A suffix stands
  // for the key only when a file holding it names the cut-off namespace (`groups.knobs.title` → a
  // `groupKnobsEn` module): an unrelated root `emptyPlaceholder` elsewhere is no home of `orders.…`.
  const keyOffered = (k) => {
    if (
      keysNow.has(k) ||
      keysNow.has(k.replace(PLURAL, '')) ||
      ['one', 'other'].some((s) => keysNow.has(`${k}_${s}`))
    )
      return true;
    const segs = k.split('.');
    for (let i = 1; i < segs.length; i++) {
      const holders = keysNow.get(segs.slice(i).join('.'));
      const ns = squash(segs[i - 1]).replace(/s$/, '');
      if (holders && ns.length >= 3 && holders.some((f) => hintOf.get(f)?.includes(ns)))
        return true;
    }
    return false;
  };
  // A root key of a per-namespace module (`archiveTitle`, `run-busy`) is searched on its own — its
  // namespace is added by a composer this tool cannot follow. Only a distinctive one: camelCase,
  // kebab or snake, six characters or more; a bare `title` would match the vocabulary.
  const DISTINCT_LEAF = /^[a-z][a-z0-9]*(?:[A-Z_-][A-Za-z0-9_-]*)+$/;

  const tokens = new Map(); // token → { kind, from }
  const put = (token, kind, from) => {
    if (!tokens.has(token)) tokens.set(token, { kind, from });
  };
  // Routes the change declares again, as whole pieces: a substring test let `/archived` hide a removed `/archive`.
  const addedPieces = new Set();
  for (const re of [...ROUTE_DECL, ...FE_ROUTE])
    for (const m of added.matchAll(re)) {
      const rp = routePiece(m[1]);
      if (rp) addedPieces.add(rp.piece);
    }
  for (const f of producers) {
    if (olds.has(f) && SOURCE.test(f) && family(f) !== 'other') {
      const now = new Set(exportsOf(f, nowText(f)));
      for (const n of exportsOf(f, olds.get(f)))
        if (!now.has(n) && !COMMON_NAME.test(n) && !n.startsWith('_')) put(n, 'name', f);
    }
    for (const l of removed.get(f)) {
      for (const m of l.matchAll(TEST_ID_ATTR)) if (!offeredIds.has(m[1])) put(m[1], 'testid', f);
      if (SOURCE.test(f))
        for (const re of [...ROUTE_DECL, ...FE_ROUTE])
          for (const m of l.matchAll(re)) {
            const rp = routePiece(m[1]);
            if (rp && !addedPieces.has(rp.piece)) put(rp.piece, 'route', f);
          }
    }
    if (isDict(f) && olds.has(f))
      for (const k of keyPaths(olds.get(f), /\.ya?ml$/i.test(f))) {
        const ok = k.includes('.')
          ? k.length >= 5
          : k.length >= 6 && DISTINCT_LEAF.test(k) && !COMMON_NAME.test(k);
        if (ok && !keyOffered(k)) put(k, 'i18n', f);
      }
  }
  if (!tokens.size)
    return { scanned: 0, searched: [], rows: [], skipped: [], declaredElsewhere: [], error: null };

  // Round-robin over kinds under the cap, so a mass rename of keys never crowds out the one removed export.
  const byKind = new Map();
  for (const [t, v] of tokens) {
    if (!byKind.has(v.kind)) byKind.set(v.kind, []);
    byKind.get(v.kind).push(t);
  }
  const order = [];
  const queues = ['name', 'testid', 'route', 'i18n'].map((k) => byKind.get(k) ?? []);
  for (let i = 0; order.length < tokens.size; i++)
    for (const q of queues) if (q[i]) order.push(q[i]);
  const use = order.slice(0, LINE_TOKENS_MAX);
  const skipped = order.slice(LINE_TOKENS_MAX);

  // One git grep per boundary mode. Routes sit inside longer URLs (`${base}/v1/x`), so `-w` would miss
  // them; the rest are whole words. Lines come back as `file:text` and the token is re-found in JS, so
  // one pass answers every token at once.
  const grep = (list, word) => {
    if (!list.length) return { lines: [], error: null };
    const args = [
      '-c',
      'core.quotePath=false',
      'grep',
      '--untracked',
      '-I',
      '-F',
      '--no-color',
      ...(word ? ['-w'] : []),
    ];
    for (const t of list) args.push('-e', t);
    const r = spawnSync('git', args, {
      cwd: root,
      encoding: 'utf8',
      maxBuffer: 64 << 20,
      timeout: Math.max(5000, DEADLINE - Date.now()),
    });
    if (r.error || (r.status !== 0 && r.status !== 1))
      return {
        lines: [],
        error: r.error?.code ?? (r.stderr || `exit ${r.status}`).trim().slice(0, 120),
      };
    return { lines: (r.stdout || '').split('\n').filter(Boolean), error: null };
  };
  const words = use.filter((t) => tokens.get(t).kind !== 'route');
  const raws = use.filter((t) => tokens.get(t).kind === 'route');
  const a = grep(words, true);
  const b = grep(raws, false);
  const error = a.error || b.error;

  const hits = new Map(); // token → Map(file → [line])
  // `-w` treats `-` and `.` as boundaries; each kind has its own alphabet, so `order-row` is not read by
  // `order-row-actions`, `orders.title` not by `orders.title.sub`, `/api/x/archive` not by `/archive-v2`.
  // Before a key a `.` is allowed — that is the namespace a composer prefixed.
  const EDGE = {
    name: [/[\w$]/, /[\w$]/],
    testid: [/[\w.:-]/, /[\w.:-]/],
    i18n: [/[\w-]/, /[\w.-]/],
    route: [/(?!)/, /[\w-]/],
  };
  const bounded = (text, t, kind) => {
    const [before, after] = EDGE[kind];
    for (let i = text.indexOf(t); i >= 0; i = text.indexOf(t, i + 1))
      if ((i === 0 || !before.test(text[i - 1])) && !after.test(text[i + t.length] ?? ''))
        return true;
    return false;
  };
  for (const [list, out] of [
    [words, a.lines],
    [raws, b.lines],
  ])
    for (const row of out) {
      const cut = row.indexOf(':');
      if (cut < 0) continue;
      const file = row.slice(0, cut);
      const text = row.slice(cut + 1);
      if (GENERATED.test(file) || LOCKFILE.test(file)) continue;
      for (const t of list) {
        if (!bounded(text, t, tokens.get(t).kind)) continue;
        if (!hits.has(t)) hits.set(t, new Map());
        const m = hits.get(t);
        if (!m.has(file)) m.set(file, []);
        m.get(file).push(text);
      }
    }

  const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const rows = [];
  const declaredElsewhere = [];
  for (const t of use) {
    const { kind, from } = tokens.get(t);
    const where = new Map(hits.get(t) ?? []);
    // A name is imported within its own language only: a removed TS helper matched a Go function of the
    // same name in a sibling service. Test ids, routes and keys are text and cross languages on purpose.
    if (kind === 'name')
      for (const f of [...where.keys()]) if (family(f) !== family(from)) where.delete(f);
    const outside = [...where.keys()].filter((f) => !allChanged.has(f) && f !== from);
    // Still produced outside the change → not removed, only moved: another declaration of the name, an
    // attribute still rendering the id, a handler still declaring the route. Such a token is no row.
    const lineOf = (f) => where.get(f) ?? [];
    let readers = outside;
    if (kind === 'name') {
      // Declared in another file — edited ones included, that is where a moved declaration lands.
      const decl = new RegExp(
        `(^|[^\\w$])(function\\*?|const|let|var|class|interface|type|enum|def|func)\\s+(\\([^)]*\\)\\s*)?${esc(t)}([^\\w$]|$)`,
      );
      const homes = [...where.keys()].filter(
        (f) => f !== from && lineOf(f).some((l) => decl.test(l)),
      );
      if (family(from) === 'js') {
        // JS says where a name comes from: a reader is a file whose import of it still leads to the old
        // module, and not to a module that declares it now (a barrel above both). A same-named private
        // helper somewhere else no longer hides the importer that breaks.
        const word = new RegExp(`(^|[^\\w$])${esc(t)}([^\\w$]|$)`);
        readers = outside.filter((f) =>
          importsOf(slurp(f)).some(
            (im) =>
              (word.test(im.names) || (/\*/.test(im.names) && word.test(slurp(f)))) &&
              pointsAt(im.source, f, from) &&
              !homes.some((h) => pointsAt(im.source, f, h)),
          ),
        );
      } else if (homes.length) {
        // Go and Python imports name a package, not a file: another declaration is taken as the move,
        // and counted so the skip is visible.
        declaredElsewhere.push(t);
        continue;
      }
    }
    if (
      kind === 'testid' &&
      outside.some(
        (f) =>
          !QA_PATH.test(f) &&
          lineOf(f).some((l) => [...l.matchAll(TEST_ID_ATTR)].some((m) => m[1] === t)),
      )
    )
      continue;
    if (
      kind === 'route' &&
      outside.some(
        (f) =>
          !QA_PATH.test(f) &&
          lineOf(f).some((l) =>
            [...ROUTE_DECL, ...FE_ROUTE].some((re) =>
              [...l.matchAll(re)].some((m) => routePiece(m[1])?.piece === t),
            ),
          ),
      )
    )
      continue;
    // A sibling dictionary (the other locale) carries the key; it is not a reader of it.
    readers = readers
      .filter((f) => !(kind === 'i18n' && I18N_PATH.test(f) && I18N_EXT.test(f)))
      .sort();
    if (!readers.length) continue;
    rows.push({
      token: t,
      kind,
      from,
      files: readers,
      qa: readers.filter((f) => QA_PATH.test(f)).length,
      inDiff: [...where.keys()].filter((f) => allChanged.has(f) && f !== from).length,
    });
  }
  // QA-carrying rows first — a red e2e run is the blocker that surfaces last — then the widest.
  rows.sort(
    (x, y) =>
      (y.qa > 0) - (x.qa > 0) || y.files.length - x.files.length || x.token.localeCompare(y.token),
  );
  return { scanned: use.length, searched: use, rows, skipped, declaredElsewhere, error };
}
const lineStarted = Date.now();
const lineConsumers = computeLineConsumers();
if (argv.includes('--explain') && lineConsumers)
  console.error(`line consumers: ${lineConsumers.scanned} tokens, ${Date.now() - lineStarted} ms`);

// ---- zones -----------------------------------------------------------------------------------------
// A change too big for one reader is split before reading, not after: each zone is a lane candidate
// with its own size and markers, and `--paths <zone>` re-runs this tool for exactly that lane.
const zoneOf = (f) => {
  const p = pkgOf(f);
  if (p) return p;
  const segs = f.split('/');
  return segs.length > 2 ? segs.slice(0, 2).join('/') : segs.length === 2 ? segs[0] : '(root)';
};
const zones = (() => {
  const z = new Map();
  const get = (f) => {
    const k = zoneOf(f);
    if (!z.has(k))
      z.set(k, {
        zone: k,
        files: 0,
        behaviour: 0,
        added: 0,
        removed: 0,
        markers: new Set(),
        untested: 0,
      });
    return z.get(k);
  };
  for (const f of allChanged) {
    const e = get(f);
    e.files++;
    e.added += addedBy.get(f)?.length ?? 0;
    e.removed += removedBy.get(f)?.length ?? 0;
    if (SOURCE.test(f) && !GENERATED.test(f) && !IS_TEST.test(f) && !DECLARATION_ONLY.test(f))
      e.behaviour++;
    if (isUntested(f)) e.untested++;
    for (const [why, re] of PATH_MARKERS) if (re.test(f) && !IS_TEST.test(f)) e.markers.add(why);
    const bearing =
      (SOURCE.test(f) && !IS_TEST.test(f) && !GENERATED.test(f)) ||
      /\.(sql|proto|graphql)$/i.test(f) ||
      SCHEMA_PATH.test(f);
    if (bearing)
      for (const [why, re] of KEYWORD_MARKERS)
        if ((addedBy.get(f) ?? []).some((l) => re.test(l))) e.markers.add(why);
  }
  return [...z.values()]
    .map((e) => ({ ...e, markers: [...e.markers] }))
    .sort((a, b) => b.added + b.removed - (a.added + a.removed) || a.zone.localeCompare(b.zone));
})();

const PROTOCOL = {
  T0: [
    'Behaviour does not change: text, docs, comment or formatting edit.',
    'Project gate. No live run needed. One line in the report saying why T0.',
  ],
  T1: [
    'Project gate · every touched symbol followed to its other call sites.',
    'Live: one positive path and one negative.',
    'Defect fixed → red-before / green-after with the same command.',
  ],
  T2: [
    'Everything from T1, plus:',
    'mustfail over the changed files: node <kit>/tools/mustfail.mjs --cmd "<tests>"',
    'Review through two entry points (diff / frame), not two copies of one pass.',
    'Live, two variations of four: one of N requests delayed · a role without the right ·',
    '  empty state · knowingly bad input.',
    'An authority exists (Figma, OpenAPI, acceptance table) → compare in both directions.',
  ],
};

if (AS_JSON) {
  console.log(
    JSON.stringify(
      {
        tier,
        base,
        zone: ZONE_ARG,
        files: [...files],
        markers,
        untested,
        caps: CAPS[tier],
        radius,
        http,
        strings,
        lineConsumers,
        zones,
      },
      null,
      2,
    ),
  );
  process.exit(0);
}

const lines = [
  `VERIFICATION TIER: ${tier} · base ${base.slice(0, 12)} · files ${files.size} (behavioural ${behaviour.length})`,
];
if (ZONE_ARG.length)
  lines.push(
    `ZONE: ${ZONE_ARG.join(', ')} — ${files.size} of ${allChanged.size} diff files; consumers are searched across the whole repository.`,
  );
if (markers.length) {
  lines.push('', 'What raised the tier:');
  for (const m of markers.slice(0, 6)) lines.push(`  · ${m.why} — ${m.where}`);
}
lines.push('', ...PROTOCOL[tier]);

if (zones.length > 1) {
  const k = (n) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));
  lines.push(
    '',
    `ZONES (${zones.length}) — a coverage line in the report for each; one lane per zone: --paths <zone>:`,
  );
  for (const z of zones.slice(0, 12))
    lines.push(
      `  ${ZONE_ARG.length && inZone(z.zone) ? '▶' : '·'} ${z.zone} — ${z.files} f. (+${k(z.added)}/−${k(z.removed)}), behavioural ${z.behaviour}${z.untested ? `, untested ${z.untested}` : ''}${z.markers.length ? ` · ${z.markers.join(', ')}` : ''}`,
    );
  if (zones.length > 12) lines.push(`  …${zones.length - 12} more (--json)`);
}

if (radius) {
  const cap = CAPS[tier];
  const direct = radius.consumers.filter((c) => c.hop === 1).length;
  const pkgs = new Set([...radius.consumers.map((c) => pkgOf(c.file)), ...behaviour.map(pkgOf)])
    .size;
  lines.push(
    '',
    `RADIUS: consumers ${radius.consumers.length}${radius.truncated ? '+' : ''} (direct ${direct}, outside the diff ${radius.consumers.filter((c) => !c.inDiff).length}) · entry points ${radius.entries.length} · packages ${pkgs} · tests in radius ${radius.tests.length}`,
  );
  if (radius.stopped)
    lines.push(
      `  ✗ NOT SEARCHED: walk stopped at hop ${radius.stopped.hop} — ${radius.stopped.reason}; ${radius.stopped.pending} file(s) without a consumer search. The radius is incomplete: no "clean" verdict on it.`,
    );
  if (radius.entries.length) {
    lines.push(
      `  Entry points — walk live ${Math.min(cap.entries, radius.entries.length)} of ${radius.entries.length} (cap ${tier}: ${cap.entries}):`,
    );
    radius.entries.forEach((e, i) => {
      const mark = i < cap.entries ? '→' : '✗';
      const chain = e.chain.length
        ? `  ← ${e.chain.join(' ← ')}`
        : e.hop === 0
          ? '  (in diff)'
          : '';
      if (i < cap.entries + 4) lines.push(`    ${mark} ${e.label}${chain}`);
    });
    if (radius.entries.length > cap.entries + 4)
      lines.push(`    ✗ …${radius.entries.length - cap.entries - 4} more (full list: --json)`);
    if (radius.entries.length > cap.entries)
      lines.push('    ✗ = over the cap: into the report as a "not walked" line, never silently.');
  } else
    lines.push(
      '  No entry points found: find the screen in the code by hand and name it in the report.',
    );
  if (radius.consumers.length) {
    lines.push(
      `  Consumers — a verdict line in the review for each, up to ${cap.rows} (cap ${tier}):`,
    );
    radius.consumers
      .slice(0, Math.min(cap.rows, 15))
      .forEach((c) =>
        lines.push(`    ${c.hop} · ${c.file}  ← ${c.sym}${c.inDiff ? '  [in diff]' : ''}`),
      );
    const rest = radius.consumers.length - Math.min(cap.rows, 15);
    if (rest > 0)
      lines.push(
        `    …${rest} more (--json)${radius.consumers.length > cap.rows ? ` · over ${cap.rows} — one per usage shape, the rest as a list` : ''}`,
      );
  }
  for (const h of radius.hubs.slice(0, 4))
    lines.push(
      `  Hub: ${h.file} — ${h.consumers} consumers in ${h.packages} pkg. (${h.pkgList.slice(0, 6).join(', ')}${h.pkgList.length > 6 ? ', …' : ''}): sample ${HUB_SAMPLE} across distinct usage shapes; severity = the worst package.`,
    );
  if (radius.tests.length)
    lines.push(
      `  Tests in radius (${radius.tests.length}): ${radius.tests.slice(0, 4).join(', ')}${radius.tests.length > 4 ? ', …' : ''}`,
    );
  if (http?.rows.length) {
    lines.push(
      `  HTTP CONSUMERS (imports do not see them) — ${http.rows.length} routes called from other packages; a verdict line per package, severity = the worst:`,
    );
    for (const r of http.rows.slice(0, HTTP_ROWS))
      lines.push(
        `    «${r.route}» (${r.owner}) → ${r.packages.join(', ')}: ${r.files.slice(0, 3).join(', ')}${r.files.length > 3 ? ', …' : ''}${r.tests ? ` · tests ${r.tests}` : ''}`,
      );
    if (http.rows.length > HTTP_ROWS)
      lines.push(`    …${http.rows.length - HTTP_ROWS} more (--json)`);
  } else if (http?.routes)
    lines.push(
      `  No HTTP consumers: ${http.routes - http.overflow} route(s) from the touched files appear in no other package.`,
    );
  if (http?.overflow)
    lines.push(`  ✗ NOT SEARCHED: ${http.overflow} route(s) of ${http.routes} — budget exhausted.`);
  if (strings?.overflow)
    lines.push(
      `  ✗ NOT SEARCHED: ${strings.overflow} changed literal(s) of ${strings.overflow + strings.scanned} — budget exhausted; their couplings are unknown.`,
    );
  if (strings?.couplings.length) {
    lines.push(
      `  STRING COUPLINGS (imports do not see them) — ${strings.couplings.length} matches, a verdict line for each:`,
    );
    for (const c of strings.couplings.slice(0, STR_ROWS))
      lines.push(
        `    «${c.literal}» — ${c.files.length} file(s): ${c.files.slice(0, 3).join(', ')}${c.files.length > 3 ? ', …' : ''}`,
      );
    if (strings.couplings.length > STR_ROWS)
      lines.push(`    …${strings.couplings.length - STR_ROWS} more (--json)`);
  } else if (strings) {
    lines.push(
      `  No string couplings: ${strings.scanned} changed literal(s) searched across the repository, none outside the diff.`,
    );
  }
  if (strings?.unconsumed.length) {
    const u = strings.unconsumed;
    lines.push(
      `  NEW STRINGS WITHOUT A CONSUMER (added by the producer, absent outside the diff) — ${u.length}, a verdict line for each: who reads it, or why no reader is needed:`,
    );
    for (const x of u.slice(0, STR_ROWS)) {
      const also = x.inDiff.length
        ? `read in the diff by: ${x.inDiff.slice(0, 3).join(', ')}${x.inDiff.length > 3 ? ', …' : ''}`
        : 'nowhere else';
      lines.push(`    «${x.literal}» — added in ${x.addedIn.slice(0, 2).join(', ')} · ${also}`);
    }
    if (u.length > STR_ROWS) lines.push(`    …${u.length - STR_ROWS} more (--json)`);
  }
}
if (lineConsumers) {
  const lc = lineConsumers;
  const KIND = { name: 'name', testid: 'test-id', route: 'route', i18n: 'i18n key' };
  if (lc.error)
    lines.push(
      '',
      `✗ NOT SEARCHED: consumers of changed strings — git grep failed (${lc.error}); removed names and keys are unchecked.`,
    );
  else if (lc.rows.length) {
    lines.push(
      '',
      `CONSUMERS OF CHANGED STRINGS (removed or renamed in the diff, still used outside it; tests, e2e and QA included) — ${lc.rows.length}, a verdict line for each:`,
    );
    // Tokens with the same source and the same readers are one verdict: fourteen keys dropped from one
    // dictionary and still read by one orphaned screen are one row, not fourteen.
    const grouped = new Map();
    for (const r of lc.rows) {
      const k = `${r.kind}|${r.from}|${r.files.join(',')}`;
      if (!grouped.has(k)) grouped.set(k, { ...r, tokens: [] });
      grouped.get(k).tokens.push(r.token);
    }
    const rows = [...grouped.values()];
    for (const r of rows.slice(0, LINE_ROWS)) {
      const toks = `${r.tokens
        .slice(0, 3)
        .map((t) => `«${t}»`)
        .join(', ')}${r.tokens.length > 3 ? ` +${r.tokens.length - 3}` : ''}`;
      lines.push(
        `  · ${KIND[r.kind]} ${toks} (${r.from}) → ${r.files.length} file(s): ${r.files.slice(0, 3).join(', ')}${r.files.length > 3 ? ', …' : ''}${r.qa ? ` · in tests/QA ${r.qa}` : ''}${r.inDiff ? ` · also in diff ${r.inDiff}` : ''}`,
      );
    }
    if (rows.length > LINE_ROWS) lines.push(`  …${rows.length - LINE_ROWS} more (--json)`);
  } else if (lc.scanned)
    lines.push(
      '',
      `No consumers of changed strings: ${lc.scanned} removed names, test ids, routes and keys appear nowhere outside the diff.`,
    );
  if (lc.declaredElsewhere.length)
    lines.push(
      `  Not strings: ${lc.declaredElsewhere.length} removed Go/Python names are declared in another file and counted as a move: ${lc.declaredElsewhere.slice(0, 5).join(', ')}${lc.declaredElsewhere.length > 5 ? ', …' : ''}.`,
    );
  if (lc.skipped.length)
    lines.push(
      `✗ NOT SEARCHED: ${lc.skipped.length} removed token(s) over the cap ${LINE_TOKENS_MAX} — list in --json (lineConsumers.skipped). Each needs its own verdict: \`git grep -wF <token>\` by hand, or rerun with --paths <zone> per zone.`,
    );
}
console.log(lines.join('\n'));
