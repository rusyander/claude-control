#!/usr/bin/env node
// Deterministic hunt passes for deep-review — the parts of SKILL §2 a script does better than a reader.
// Each prints CANDIDATES (never findings): a reader confirms or kills every row. Prose passes got
// skipped on !778 (lanes stopped at ~100 tool calls); a command's output cannot be skipped silently.
//
//   node review-sweep.mjs <cmd> --base <sha> [--head <sha>] [--repo <dir>] [--paths a,b] [--out <file>]
//     sweep    added lines × the regex tables of deep-review/references/{backend,data-deploy,frontend}.md;
//              removed lines × what stopped happening (Close, Rollback, rows.Err, ctx, validation, LIMIT…)
//     guards   guard census per function, base vs head: a count that dropped, a new handler with none
//     renames  a name the diff removed (env var, route, snake/kebab key) that no changed file still has,
//              yet the repo still references at head — CI, helm, docs, .env included
//     knobs    env vars the added lines read: code default vs chart / .env / compose, `| default` eating 0
//     mutants  a mustfail --mutants plan over changed guard lines (negate, boundary, early return, n±1);
//              [--test <name that must fail>] [--cmd "<test cmd>"]; run on a scratch clone, never the reviewed tree
//     all      sweep + guards + renames + knobs
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const REFS = path.join(os.homedir(), '.claude', 'skills', 'deep-review', 'references');
const TABLES = ['backend.md', 'data-deploy.md', 'frontend.md'];
const FRONT = /\.(tsx?|jsx?|mjs|cjs)$/;
const LANG = {
  Go: /\.go$/,
  Py: /\.py$/,
  SQL: /\.(sql|go|py)$/,
  Helm: /\.(ya?ml|tpl)$/,
  test: /\.(test|spec)\.(tsx?|jsx?)$/,
};
const CASELESS = new Set(['SQL', 'Helm']);
const REMOVED = [
  ['defer .*Close|\\.Close\\(\\)', 'a Close stopped happening'],
  ['Rollback|rollback\\(', 'a rollback stopped happening'],
  ['rows\\.Err\\(', 'iteration error no longer checked'],
  ['ctx context\\.Context|ctx\\s*:?=|signal', 'cancellation no longer threaded'],
  [
    '[Vv]alidat|[Ss]anitiz|[Aa]uthori[sz]|[Pp]ermission|Require\\w*\\(|hasPermission|checkAccess',
    'a guard or validation removed',
  ],
  ['\\bLIMIT\\b|\\.limit\\(|[Tt]imeout', 'a bound removed'],
  ['encodeURIComponent|escape\\(|html\\.EscapeString|quote\\(', 'an encoding removed'],
  ['\\.Unlock\\(|finally', 'a release path removed'],
];
const GUARD =
  /\b(Require\w*|[Aa]uthori[sz]\w*|[Pp]ermission\w*|hasPermission|useHasPermission|can[A-Z]\w*|[Vv]alidat\w*|[Ss]anitiz\w*|RateLimit\w*|[Ll]imit\w*|checkAccess|ensure\w*Access|verify\w*|writeBlocked|readBlocked)\s*\(/g;
const ENTRY = {
  go: /http\.ResponseWriter|\*gin\.Context|echo\.Context|\*fiber\.Ctx|connect\.Request\[/,
  py: /@\w+\.(get|post|put|patch|delete|route|websocket)\(/,
};
const SKIP =
  /(^|\/)(node_modules|vendor|dist|build)\/|\.(lock|min\.js|map|snap|svg|png)$|package-lock\.json|pnpm-lock\.yaml|go\.sum/;
// Test code and data sets that merely look like code: every table row but `test` skips them.
const TESTISH =
  /(_test\.go|\.test\.[jt]sx?|\.spec\.[jt]sx?|(^|\/)test_[^/]*\.py|_test\.py)$|(^|\/)(tests?|__tests__|e2e|testdata|fixtures?|datasets?|__snapshots__|QA)\//;
const DEPLOY = /\.(ya?ml|tpl|env)$|(^|\/)\.env[^/]*$|docker-compose|Dockerfile|Makefile$/i;

function args(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) out[a.slice(2)] = true;
      else out[a.slice(2)] = argv[++i];
    } else out._.push(a);
  }
  return out;
}
function git(repo, ...a) {
  const r = spawnSync('git', ['-C', repo, ...a], {
    encoding: 'utf8',
    maxBuffer: 512 * 1024 * 1024,
  });
  return r.status === 0 ? r.stdout : '';
}

/** Added and removed lines with their file and line number (head side for +, base side for -). */
export function diffLines(repo, base, head, paths = []) {
  const out = { added: [], removed: [], files: new Set() };
  let file = null;
  let a = 0;
  let r = 0;
  for (const l of git(repo, 'diff', '-U0', '-M', base, head, '--', ...paths).split('\n')) {
    if (l.startsWith('+++ ')) {
      file = l.slice(4).replace(/^b\//, '');
      if (file === '/dev/null') file = null;
      else out.files.add(file);
      continue;
    }
    if (l.startsWith('--- ')) continue;
    const h = l.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
    if (h) {
      r = +h[1];
      a = +h[2];
      continue;
    }
    if (!file || SKIP.test(file)) continue;
    if (l.startsWith('+')) out.added.push({ file, line: a++, text: l.slice(1) });
    else if (l.startsWith('-')) out.removed.push({ file, line: r++, text: l.slice(1) });
  }
  return out;
}

export function loadTables(dir = REFS) {
  const rows = [];
  for (const f of TABLES) {
    let t;
    try {
      t = readFileSync(path.join(dir, f), 'utf8');
    } catch {
      continue;
    }
    for (const b of t.matchAll(/^```text\n([\s\S]*?)^```/gm))
      for (const r of b[1].split('\n').filter(Boolean)) {
        const m = r.match(/^(\S+)\s+(.+?)\s{2,}(\S.*)$/);
        if (!m) continue;
        const scope = LANG[m[1]] ?? (f === 'frontend.md' ? FRONT : null);
        if (!scope) continue;
        rows.push({
          ref: f,
          tag: m[1],
          re: new RegExp(m[2], CASELESS.has(m[1]) ? 'i' : ''),
          note: m[3],
          scope,
        });
      }
  }
  return rows;
}

/** A `defer` counts only when an enclosing block of its function opens with `for` (gofmt indentation). */
export function deferInLoop(src, line) {
  const lines = src.split('\n');
  const ind = (s) => s.match(/^\t*/)[0].length;
  let min = ind(lines[line - 1] ?? '');
  for (let i = line - 2; i >= 0 && min > 0; i--) {
    const l = lines[i];
    if (!l.trim() || ind(l) >= min) continue;
    min = ind(l);
    if (/^\s*for\b/.test(l)) return true;
    if (/^func\b/.test(l)) return false;
  }
  return false;
}
// Rows whose regex cannot see enough: a refinement over the head source, keyed by tag + regex.
const REFINE = [
  { tag: 'Go', re: /defer/, keep: (l, src) => deferInLoop(src(), l.line) },
  { tag: 'Go', re: /, _ :\?=/, keep: (l) => !/\brange\b/.test(l.text) },
];

/** Hits grouped per table row: count, first `cap` locations, the rest as a file list. */
export function sweep(d, { tables = loadTables(), repo = '.', head = 'HEAD', cap = 15 } = {}) {
  const out = [];
  const srcs = new Map();
  const src = (f) => () =>
    srcs.has(f) ? srcs.get(f) : srcs.set(f, git(repo, 'show', `${head}:${f}`)).get(f);
  const group = (label, hits) => {
    if (!hits.length) return;
    const shown = cap ? hits.slice(0, cap) : hits;
    const rest = [...new Set(hits.slice(shown.length).map((h) => h.file))];
    out.push(
      `${label} — ${hits.length}`,
      ...shown.map((h) => `    ${h.file}:${h.line} \`${h.text.trim().slice(0, 100)}\``),
    );
    if (rest.length)
      out.push(
        `    +${hits.length - shown.length} more in ${rest.slice(0, 8).join(', ')}${rest.length > 8 ? ` +${rest.length - 8} files` : ''}`,
      );
  };
  for (const row of tables) {
    const refine = REFINE.find((r) => r.tag === row.tag && r.re.test(row.re.source));
    group(
      `+ [${row.tag}] ${row.note}`,
      d.added.filter(
        (l) =>
          row.scope.test(l.file) &&
          (row.tag === 'test' || !TESTISH.test(l.file)) &&
          row.re.test(`${l.file}:${l.line}: ${l.text}`) &&
          (!refine || refine.keep(l, src(l.file))),
      ),
    );
  }
  const addedText = new Set(d.added.map((l) => l.text.trim()));
  for (const [re, note] of REMOVED) {
    const rx = new RegExp(re);
    group(
      `- ${note}`,
      d.removed.filter(
        (l) => !TESTISH.test(l.file) && rx.test(l.text) && !addedText.has(l.text.trim()),
      ),
    );
  }
  return out;
}

/** Top-level functions of a source file with their text: Go/TS by the next top-level start, Python by indent. */
export function functions(file, text) {
  const lines = text.split('\n');
  const starts = [];
  const py = file.endsWith('.py');
  const START = file.endsWith('.go')
    ? /^func\s+(?:\([^)]*\)\s*)?(\w+)/
    : py
      ? /^(\s*)(?:async\s+)?def\s+(\w+)/
      : /^(?:export\s+)?(?:default\s+)?(?:async\s+)?(?:function\s*\*?\s*(\w+)|const\s+(\w+)\s*=\s*(?:async\s*)?(?:\([^)]*\)|\w+)\s*=>)/;
  lines.forEach((l, i) => {
    const m = l.match(START);
    if (m) starts.push({ i, name: py ? m[2] : (m[1] ?? m[2]), indent: py ? m[1].length : 0 });
  });
  return starts.map((s, k) => {
    let end = k + 1 < starts.length ? starts[k + 1].i : lines.length;
    if (py) {
      const nxt = starts.slice(k + 1).find((t) => t.indent <= s.indent);
      end = nxt ? nxt.i : lines.length;
    }
    let top = s.i;
    while (top > 0 && /^\s*@/.test(lines[top - 1])) top--; // Python decorators belong to the def
    return { name: s.name, body: lines.slice(top, end).join('\n') };
  });
}

const count = (s) => (s.match(GUARD) ?? []).length;

/** Where a handler is wired: `.Name` / `Name,` references outside its own file and outside tests. */
function registrations(repo, head, name, self) {
  return git(repo, 'grep', '-n', '-E', '-e', `[.(, ]${name}\\b`, head, '--', '*.go', '*.py')
    .split('\n')
    .filter(Boolean)
    .map((h) => h.replace(`${head}:`, '').match(/^(.+?):(\d+):(.*)$/))
    .filter(
      (m) =>
        m &&
        m[1] !== self &&
        !TESTISH.test(m[1]) &&
        !new RegExp(`func\\s+(\\([^)]*\\)\\s*)?${name}\\b|def\\s+${name}\\b`).test(m[3]),
    );
}

export function guards(repo, base, head, files) {
  const out = [];
  for (const f of files) {
    if (!/\.(go|py|[mc]?[jt]sx?)$/.test(f) || TESTISH.test(f)) continue;
    const entry = ENTRY[path.extname(f).slice(1)];
    const before = new Map(
      functions(f, git(repo, 'show', `${base}:${f}`)).map((x) => [x.name, count(x.body)]),
    );
    const bare = [];
    for (const fn of functions(f, git(repo, 'show', `${head}:${f}`))) {
      const now = count(fn.body);
      const was = before.get(fn.name);
      if (was !== undefined && now < was) out.push(`${f} ${fn.name}: guard calls ${was} → ${now}`);
      else if (
        was === undefined &&
        now === 0 &&
        (!f.endsWith('.go') || /^[A-Z]/.test(fn.name)) &&
        entry?.test(fn.body.split('\n').slice(0, 4).join('\n'))
      ) {
        // a guard on the route line (r.With(RequireRole(..)).Post(.., h.X)) covers it; a guarded group does not show here
        const regs = registrations(repo, head, fn.name, f);
        if (regs.some((m) => (m[3].match(GUARD) ?? []).length)) continue;
        bare.push(
          `${fn.name} (${regs.length ? `${regs[0][1]}:${regs[0][2]}` : 'no registration found'})`,
        );
      }
    }
    if (bare.length)
      out.push(
        `${f}: ${bare.length} new entry point${bare.length > 1 ? 's' : ''}, no guard in the body or on the route line — read the enclosing route group: ${bare.join(', ')}`,
      );
  }
  return out;
}

const NAME_SHAPES = [
  /\b[A-Z][A-Z0-9]*_[A-Z0-9_]{2,}\b/g, // env var, constant
  /["'`](\/[\w\-/{}:.]{3,})["'`]/g, // route
  /\b[a-z][a-z0-9]*(?:_[a-z0-9]+){2,}\b/g, // snake key, metric
  /--[a-z][a-z0-9]+(?:-[a-z0-9]+)+/g, // CLI flag
];
export function renames(repo, head, d, max = 300) {
  const addedJoined = d.added.map((l) => l.text).join('\n');
  const tokens = new Set();
  for (const l of d.removed.filter((x) => !TESTISH.test(x.file)))
    for (const re of NAME_SHAPES)
      for (const m of l.text.matchAll(re)) {
        const t = m[1] ?? m[0];
        if (!addedJoined.includes(t)) tokens.add(t);
      }
  const out =
    tokens.size > max
      ? [`(${tokens.size} names removed, first ${max} checked — narrow with --paths)`]
      : [];
  for (const t of [...tokens].slice(0, max)) {
    const hits = git(repo, 'grep', '-l', '-F', '-e', t, head)
      .split('\n')
      .filter(Boolean)
      .map((h) => h.replace(`${head}:`, ''));
    if (!hits.length || hits.some((h) => d.files.has(h))) continue;
    out.push(
      `${t}: gone from the changed files, still in ${hits.slice(0, 6).join(', ')}${hits.length > 6 ? ` +${hits.length - 6}` : ''}`,
    );
  }
  return out;
}

const KNOB_READ = [
  /(?:Getenv|LookupEnv)\("([A-Z][A-Z0-9_]+)"\)/g,
  /\b\w*[Ee]nv\w*\(\s*"([A-Z][A-Z0-9_]+)"\s*,\s*([^)]{1,60})\)/g,
  /environ(?:\.get)?\s*[([]\s*["']([A-Z][A-Z0-9_]+)["']\s*(?:,\s*([^)\]]{1,60}))?/g,
  /getenv\(\s*["']([A-Z][A-Z0-9_]+)["']\s*(?:,\s*([^)]{1,60}))?\)/g,
  /(?:process|import\.meta)\.env\.([A-Z][A-Z0-9_]+)/g,
];
export function knobs(repo, head, d) {
  const found = new Map();
  for (const l of d.added) {
    if (TESTISH.test(l.file)) continue;
    for (const re of KNOB_READ)
      for (const m of l.text.matchAll(re))
        if (!found.has(m[1]))
          found.set(m[1], { def: (m[2] ?? '').trim() || '—', at: `${l.file}:${l.line}` });
  }
  const out = [];
  const srcs = new Map();
  const src = (f) =>
    srcs.has(f) ? srcs.get(f) : srcs.set(f, git(repo, 'show', `${head}:${f}`).split('\n')).get(f);
  for (const [name, k] of found) {
    const deploy = git(repo, 'grep', '-n', '-F', '-e', name, head)
      .split('\n')
      .filter(Boolean)
      .map((h) => h.replace(`${head}:`, '').match(/^(.+?):(\d+):/))
      .filter((m) => m && DEPLOY.test(m[1]) && !TESTISH.test(m[1]))
      .map((m) => ({ file: m[1], line: +m[2] }));
    // the chart's value usually sits one or two lines under `- name: X`
    const eats = deploy.filter((h) =>
      src(h.file)
        .slice(h.line - 1, h.line + 2)
        .some((t) => /\|\s*default\b/.test(t)),
    );
    const where = deploy.length
      ? deploy
          .slice(0, 3)
          .map((h) => `${h.file}:${h.line}`)
          .join(', ') + (deploy.length > 3 ? ` +${deploy.length - 3}` : '')
      : 'none — code default only';
    out.push(
      `${name} (${k.at}) code default ${k.def} · deploy ${where}${eats.length ? ` · \`| default\` at ${eats[0].file}:${eats[0].line}: a set 0/false/"" is replaced` : ''}`,
    );
  }
  return out;
}

/** One mustfail mutant per changed guard-shaped line: negate the condition, move a boundary, n±1. */
export function mutants(repo, head, d, test, max = 40) {
  const plan = [];
  const texts = new Map();
  const perFile = new Map();
  for (const l of d.added) {
    if (plan.length >= max) break;
    if (TESTISH.test(l.file) || !/\.(go|py|[mc]?[jt]sx?)$/.test(l.file)) continue;
    if ((perFile.get(l.file) ?? 0) >= 10) continue;
    const t = l.text.trim();
    if (t.length < 6) continue;
    let rep = null;
    if (/^if\s+(.+?)\s*\{$/.test(t) && l.file.endsWith('.go'))
      rep = t.replace(/^if\s+(.+?)\s*\{$/, 'if !($1) {');
    else if (/^(?:\}\s*else\s+)?if\s*\((.+)\)\s*\{?$/.test(t))
      rep = t.replace(/if\s*\((.+)\)(\s*\{?)$/, 'if (!($1))$2');
    else if (/^(?:el)?if\s+(.+):$/.test(t)) rep = t.replace(/^(el)?if\s+(.+):$/, '$1if not ($2):');
    else if (/[^<>=!]<=[^=]/.test(t)) rep = t.replace('<=', '<');
    else if (/[^<>=!-]<[^<=-]/.test(t)) rep = t.replace(/([^<>=!-])<([^<=-])/, '$1<=$2');
    else if (/>=/.test(t)) rep = t.replace('>=', '>');
    else if (/^return\s+err\b/.test(t)) rep = t.replace(/^return\s+err\b/, 'return nil');
    else if (/\b([2-9]|\d{2,})\b/.test(t) && !/["'`]/.test(t))
      rep = t.replace(/\b([2-9]|\d{2,})\b/, (n) => String(+n + 1));
    if (!rep || rep === t) continue;
    if (!texts.has(l.file)) texts.set(l.file, git(repo, 'show', `${head}:${l.file}`));
    const src = texts.get(l.file);
    const all = [];
    for (let k = src.indexOf(t); k >= 0; k = src.indexOf(t, k + t.length))
      all.push(src.slice(0, k).split('\n').length);
    const nth = all.indexOf(l.line) + 1;
    if (!nth) continue;
    plan.push({
      file: l.file,
      find: t,
      replace: rep,
      ...(all.length > 1 ? { nth } : {}),
      ...(test ? { test } : {}),
    });
    perFile.set(l.file, (perFile.get(l.file) ?? 0) + 1);
  }
  return plan;
}

function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  const o = args(rest);
  if (!cmd || !o.base) {
    console.error(
      'usage: review-sweep.mjs sweep|guards|renames|knobs|mutants|all --base <sha> [--head <sha>] [--repo dir] [--paths a,b] [--test <name>] [--cmd "<test cmd>"] [--cap N (0 = all)] [--out file]',
    );
    return 2;
  }
  const repo = path.resolve(o.repo ?? '.');
  const head = o.head ?? 'HEAD';
  const paths = o.paths ? String(o.paths).split(',').filter(Boolean) : [];
  const d = diffLines(repo, o.base, head, paths);
  if (cmd === 'mutants') {
    const plan = mutants(repo, head, d, o.test, +(o.max ?? 40));
    const text = JSON.stringify(plan, null, 1);
    if (o.out) writeFileSync(o.out, text);
    console.log(
      o.out
        ? `mutants: ${plan.length} → ${o.out} — run on a scratch clone: node <kit>/tools/mustfail.mjs --cwd <clone> --cmd "${o.cmd ?? '<test cmd>'}" --mutants ${o.out}`
        : text,
    );
    return 0;
  }
  const sections = [];
  const add = (name, rows) =>
    sections.push(
      `## ${name} — ${rows.length}`,
      '',
      ...(rows.length ? rows.map((r) => `- ${r}`) : ['- none']),
      '',
    );
  if (cmd === 'sweep' || cmd === 'all') {
    const g = sweep(d, { repo, head, cap: +(o.cap ?? 15) });
    sections.push(
      `## sweep — ${g.filter((r) => /^[-+] /.test(r)).length} rules hit`,
      '',
      ...(g.length ? g : ['none']),
      '',
    );
  }
  if (cmd === 'guards' || cmd === 'all') add('guards', guards(repo, o.base, head, [...d.files]));
  if (cmd === 'renames' || cmd === 'all') add('renames', renames(repo, head, d));
  if (cmd === 'knobs' || cmd === 'all') add('knobs', knobs(repo, head, d));
  if (!sections.length) {
    console.error(`unknown command ${cmd}`);
    return 2;
  }
  const text = [
    `# review-sweep ${cmd} — ${o.base}..${head} · +${d.added.length} −${d.removed.length} lines · candidates, not findings`,
    '',
    ...sections,
  ].join('\n');
  if (o.out) writeFileSync(o.out, text);
  console.log(
    o.out ? `${sections.filter((s) => s.startsWith('## ')).join(' · ')} → ${o.out}` : text,
  );
  return 0;
}

if (process.argv[1]?.endsWith('review-sweep.mjs')) {
  try {
    process.exitCode = main();
  } catch (e) {
    console.error(`review-sweep: ${e.message}`);
    process.exitCode = 2;
  }
}
