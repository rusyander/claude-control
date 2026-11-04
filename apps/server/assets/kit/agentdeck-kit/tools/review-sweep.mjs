#!/usr/bin/env node
// Deterministic hunt passes for deep-review — the parts of SKILL §3 a script does better than a reader.
// Each prints CANDIDATES (never findings): a reader confirms or kills every row. Prose passes got
// skipped on a real ~460-file MR (lanes stopped at ~100 tool calls); a command's output cannot be skipped silently.
//
//   node review-sweep.mjs <cmd> --base <sha> [--head <sha>] [--repo <dir>] [--paths a,b|@file] [--out <file>]
//     --paths  comma/newline list, or @<file> with one repo-relative path per line (commas inside a line are part of
//              the path; an empty or unreadable file = exit 2); a path that matches no changed file = exit 2 (an
//              unmatched scope sweeps 0 rows, which «zero rows is a result» would record as checked); the header
//              prints «paths: N of M given matched»
//     sweep    added lines × the regex tables of deep-review/references/{backend,data-deploy,frontend}.md;
//              removed lines × what stopped happening (Close, Rollback, rows.Err, ctx, validation, LIMIT…)
//     guards   guard census per function, base vs head: a count that dropped, a new handler with none
//     renames  a name the diff removed (env var, route, snake/kebab key) that no changed file still has,
//              yet the repo still references at head — CI, helm, docs, .env included
//     knobs    env vars the added lines read: code default vs chart / .env / compose, `| default` eating 0
//     mutants  a mustfail --mutants plan over changed guard lines (negate, boundary, early return, n±1);
//              [--test <name that must fail>] [--cmd "<test cmd>"]; run on a scratch clone, never the reviewed tree
//     lint     real analyzers, rows ONLY for head-side added lines: semgrep (registry rulesets cached under
//              the kit state dir (semgrep/), refreshed after 30 days, run offline with --metrics=off), go vet and staticcheck
//              per changed package from its module root, ruff over changed .py; staticcheck/ruff installed when absent
//              and an installer exists. --repo must be checked out at --head (exit 2 otherwise: line numbers would lie).
//              [--timeout 120 (s, total wall)] [--tools semgrep,vet,staticcheck,ruff] [--no-install]
//              [--semgrep-config a.yaml,b.yaml (local rules instead of the registry)] [--cap 15 per file]
//              [--style (keep formatter/style codes: ruff E501/I/UP/W/D…, staticcheck ST*; skipped and counted by default)]
//              Tool trouble is a `# <tool>: …` header line, never a non-zero exit. eslint/tsc stay with the project gates.
//     all      sweep + guards + renames + knobs + lint (--no-lint drops it)
import { spawn, spawnSync } from 'node:child_process';
import {
  readFileSync,
  writeFileSync,
  existsSync,
  statSync,
  mkdirSync,
  mkdtempSync,
  copyFileSync,
  rmSync,
  renameSync,
  realpathSync,
} from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { pathBatches } from './lib/argv.mjs';
import { KIT_ROOT, STATE_DIR } from '../hooks/lib/kit-paths.mjs';

// The kit's own copy of the tables: a machine without a personal ~/.claude layer has no other.
const REFS = path.join(KIT_ROOT, 'skills', 'deep-review', 'references');
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
  const raw = paths.length
    ? pathBatches(paths)
        .map((b) => git(repo, 'diff', '-U0', '-M', base, head, '--', ...b))
        .join('')
    : git(repo, 'diff', '-U0', '-M', base, head);
  for (const l of raw.split('\n')) {
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

const GLOB = /[*?[]/;

/**
 * `--paths` against the files the diff really touches. Separators: comma or newline; whitespace inside an
 * item is part of a path (`my docs/a.md`) unless the item matches nothing whole — then it is read as a
 * space-separated list, longest-first so a directory with a space survives. A path that names no changed
 * file is `unmatched`: a sweep over it prints 0 rows, and «zero rows is a result» would count an empty
 * scan as a checked one (`--paths "a b c"` swept nothing, silently).
 * `files` = the diff's file names; `viaGit(item)` answers a glob item (git owns pathspec magic).
 */
export function resolvePaths(raw, files, viaGit = () => 0) {
  const clean = (s) =>
    s
      .trim()
      .replace(/^(["'])(.*)\1$/, '$2')
      .replace(/\\/g, '/')
      .replace(/^\.\//, '');
  const count = (p) =>
    GLOB.test(p)
      ? viaGit(p)
      : files.filter((f) => f === p || f.startsWith(`${p.replace(/\/+$/, '')}/`)).length;
  const paths = [];
  const unmatched = [];
  const items = Array.isArray(raw) ? raw : String(raw).split(/[,\n]/);
  for (const item of items.map(clean).filter(Boolean)) {
    if (count(item)) {
      paths.push(item);
      continue;
    }
    const words = item.split(/\s+/);
    if (words.length < 2) {
      unmatched.push(item);
      continue;
    }
    for (let i = 0; i < words.length;) {
      let took = 0;
      for (let j = words.length; j > i && !took; j--) {
        const cand = words.slice(i, j).join(' ');
        if (count(cand)) {
          paths.push(cand);
          took = j - i;
        }
      }
      if (!took) unmatched.push(words[i]);
      i += took || 1;
    }
  }
  return { paths, unmatched };
}

/**
 * A line straight from `git diff --name-only` (core.quotePath on): non-ASCII and special bytes come C-quoted,
 * `"QA/\320\242.md"`. Decoded back to the UTF-8 name; an unquoted line passes through.
 */
export function unquoteGitPath(s) {
  const m = /^"(.*)"$/.exec(s);
  if (!m || !m[1].includes('\\')) return s;
  const ESC = { a: 7, b: 8, t: 9, n: 10, v: 11, f: 12, r: 13, '"': 34, '\\': 92 };
  const bytes = [];
  const body = m[1];
  for (let i = 0; i < body.length; i++) {
    const c = body[i];
    if (c !== '\\') {
      bytes.push(...Buffer.from(c, 'utf8'));
      continue;
    }
    const oct = /^[0-7]{3}/.exec(body.slice(i + 1));
    if (oct) {
      bytes.push(parseInt(oct[0], 8));
      i += 3;
    } else {
      bytes.push(ESC[body[i + 1]] ?? body.charCodeAt(i + 1));
      i++;
    }
  }
  return Buffer.from(bytes).toString('utf8');
}

/**
 * `--paths @file`: one path per line, so a comma inside a line stays part of the path (the planner writes the
 * list to a file instead of a multi-KB inline argument). Anything else passes through unchanged.
 */
export function pathsArg(raw, read = (f) => readFileSync(f, 'utf8')) {
  if (typeof raw !== 'string' || !raw.startsWith('@')) return raw;
  const file = raw.slice(1);
  let text;
  try {
    text = read(file);
  } catch (e) {
    throw new Error(`--paths ${raw}: cannot read ${file} (${e.code ?? e.message})`, { cause: e });
  }
  const items = text
    .replace(/^\s+/, '')
    .split(/\r?\n/)
    .map((s) => unquoteGitPath(s.trim()))
    .filter(Boolean);
  if (!items.length)
    throw new Error(`--paths ${raw}: the file lists no path — an empty scope is not a clean one`);
  return items;
}

// ---------------------------------------------------------------------------------------------------------------
// lint: analyzers catch mechanical classes LLM readers skim past (unchecked errors, shadowing, ineffectual
// assignments, injection patterns, dead code). Their output is filtered to head-side ADDED lines only, so a legacy
// file does not bury the diff under its old debt.

export const SEMGREP_CACHE = path.join(STATE_DIR, 'semgrep');
const RULESET_TTL_MS = 30 * 24 * 3600 * 1000;
export const LINT_TOOLS = ['semgrep', 'vet', 'staticcheck', 'ruff'];
const GO_DEP_FAIL =
  /missing go\.sum entry|no required module provides|cannot find module|dial tcp|could not resolve|unrecognized import path|verifying (module|go\.mod)|reading https?:|toolchain not available|module lookup disabled|GOPROXY|connection refused|no such host/i;

/** head-side added line numbers per file. */
export function addedIndex(d) {
  const m = new Map();
  for (const l of d.added) {
    if (!m.has(l.file)) m.set(l.file, new Set());
    m.get(l.file).add(l.line);
  }
  return m;
}

/**
 * A tool's file name → the diff's repo-relative name. Tools print absolute, cwd-relative or backslashed paths, and
 * on Windows a long name where the repo was given as an 8.3 short one; the suffix match covers that.
 */
export function toRel(p, { cwd = '.', repo = '.', files }) {
  if (!p) return null;
  const norm = (s) => s.replace(/\\/g, '/');
  const abs = path.resolve(cwd, String(p));
  const rel = norm(path.relative(repo, abs));
  if (files.has(rel)) return rel;
  const low = norm(abs).toLowerCase();
  let best = null;
  for (const f of files.keys())
    if (low.endsWith(`/${f.toLowerCase()}`) && (!best || f.length > best.length)) best = f;
  return best;
}

export function formatLintRow(f) {
  const msg = String(f.message ?? '')
    .replace(/\s+/g, ' ')
    .trim();
  return `${f.file}:${f.line} · ${f.tool}/${f.rule} · ${msg.length > 180 ? `${msg.slice(0, 179)}…` : msg}`;
}

// Formatter/style codes: the project's own gates own them, and as review rows they bury the defects — on a real
// Python change 15 of 19 ruff rows were E501/I001/UP035 next to one real B017. `--style` keeps them.
const STYLE_RULE = {
  ruff: /^(E1\d\d|E2\d\d|E3\d\d|E501|W\d|I\d|UP\d|D\d|Q\d|COM\d|ISC\d|N\d|ANN\d|FA\d)/,
  staticcheck: /^ST\d/,
};
export function dropStyle(findings) {
  const kept = findings.filter((f) => !STYLE_RULE[f.tool]?.test(String(f.rule)));
  return { kept, style: findings.length - kept.length };
}

/** Findings on added lines only, deduped by file:line + tool/rule; `outside` = findings on untouched lines. */
export function keepAdded(findings, idx) {
  const seen = new Set();
  const kept = [];
  let outside = 0;
  for (const f of findings) {
    if (!f.file || !idx.get(f.file)?.has(f.line)) {
      outside++;
      continue;
    }
    const key = `${f.file}:${f.line}|${f.tool}/${f.rule}`;
    if (seen.has(key)) continue;
    seen.add(key);
    kept.push(f);
  }
  return { kept, outside };
}

/** Sorted rows, at most `cap` per file (0 = all), the rest folded into one «+N more» line under that file. */
export function capRows(kept, cap = 15) {
  const byFile = new Map();
  for (const f of kept) {
    if (!byFile.has(f.file)) byFile.set(f.file, []);
    byFile.get(f.file).push(f);
  }
  const rows = [];
  for (const file of [...byFile.keys()].sort()) {
    const list = byFile
      .get(file)
      .sort(
        (a, b) => a.line - b.line || `${a.tool}/${a.rule}`.localeCompare(`${b.tool}/${b.rule}`),
      );
    const shown = cap ? list.slice(0, cap) : list;
    rows.push(...shown.map(formatLintRow));
    if (list.length > shown.length) rows.push(`${file} · +${list.length - shown.length} more`);
  }
  return rows;
}

export function parseSemgrep(text) {
  const j = JSON.parse(text);
  return {
    findings: (j.results ?? []).map((r) => ({
      file: r.path,
      line: r.start?.line,
      rule: String(r.check_id ?? '?')
        .split('.')
        .pop(),
      message: r.extra?.message ?? '',
    })),
    // level `warn` = a target it could not parse (Helm templates, odd YAML): not a tool failure
    errors: (j.errors ?? [])
      .filter((e) => e.level === 'error')
      .map((e) => String(e.message ?? e.type ?? '').split('\n')[0]),
  };
}

/** `go vet -json` output: `# pkg` lines, one JSON object per package, and plain text for load/type errors. */
export function parseVet(text) {
  const findings = [];
  const errors = [];
  const s = String(text);
  let i = 0;
  // i sits at a line start or right after an object; a text line is consumed whole, so a `{` inside it is never seen
  while (i < s.length) {
    if (s[i] === '{') {
      let depth = 0;
      let inStr = false;
      let j = i;
      for (; j < s.length; j++) {
        const c = s[j];
        if (inStr) {
          if (c === '\\') j++;
          else if (c === '"') inStr = false;
        } else if (c === '"') inStr = true;
        else if (c === '{') depth++;
        else if (c === '}' && --depth === 0) break;
      }
      let obj = null;
      try {
        obj = JSON.parse(s.slice(i, j + 1));
      } catch {
        /* not JSON after all: falls through as text */
      }
      if (obj) {
        for (const pkg of Object.values(obj))
          for (const [analyzer, list] of Object.entries(pkg ?? {})) {
            if (!Array.isArray(list)) {
              if (list?.error) errors.push(`${analyzer}: ${list.error}`);
              continue;
            }
            for (const d of list) {
              const m = String(d.posn ?? '').match(/^(.*?\.\w+):(\d+)(?::\d+)?$/);
              if (m)
                findings.push({
                  file: m[1],
                  line: +m[2],
                  rule: analyzer,
                  message: d.message ?? '',
                });
            }
          }
        i = j + 1;
        continue;
      }
    }
    const nl = s.indexOf('\n', i);
    const end = nl < 0 ? s.length : nl;
    const line = s.slice(i, end).trim();
    if (line && !line.startsWith('#') && !/^go: (downloading|finding|extracting)/.test(line))
      errors.push(line);
    i = end + 1;
  }
  return { findings, errors };
}

/** `staticcheck -f json`: one object per line; code `compile` = the package did not load. */
export function parseStaticcheck(text) {
  const findings = [];
  const errors = [];
  for (const l of String(text).split('\n')) {
    if (!l.trim().startsWith('{')) {
      if (l.trim()) errors.push(l.trim());
      continue;
    }
    let o;
    try {
      o = JSON.parse(l);
    } catch {
      errors.push(l.trim());
      continue;
    }
    if (o.code === 'compile') {
      errors.push(o.message);
      continue;
    }
    findings.push({
      file: o.location?.file,
      line: o.location?.line,
      rule: o.code,
      message: o.message,
    });
  }
  return { findings, errors };
}

export function parseRuff(text) {
  const j = JSON.parse(text || '[]');
  return {
    findings: j.map((r) => ({
      file: r.filename,
      line: r.location?.row,
      rule: r.code ?? 'syntax',
      message: r.message,
    })),
    errors: [],
  };
}

/**
 * A registry ruleset as a local YAML: fetched once, reused offline, refreshed after 30 days. A failed refresh
 * keeps the stale copy (said so); no copy at all = null. `fetchImpl` is injectable for tests.
 */
export async function ensureRuleset(
  name,
  {
    dir = SEMGREP_CACHE,
    ttl = RULESET_TTL_MS,
    fetchImpl = globalThis.fetch,
    now = Date.now(),
  } = {},
) {
  const file = path.join(dir, `${name.replace(/[^\w.-]+/g, '-')}.yaml`);
  let age = Infinity;
  try {
    age = now - statSync(file).mtimeMs;
  } catch {
    /* absent */
  }
  if (age < ttl) return { file, state: 'cached' };
  try {
    const res = await fetchImpl(`https://semgrep.dev/c/${name}`, {
      signal: AbortSignal.timeout(30000),
    });
    const body = await res.text();
    // the registry answers YAML to curl and JSON to fetch; JSON is valid YAML, semgrep reads either
    if (!res.ok || !/^\s*(rules:|\{\s*"rules"\s*:)/.test(body.slice(0, 200)))
      throw new Error(`HTTP ${res.status}${res.ok ? ', not a rules file' : ''}`);
    mkdirSync(dir, { recursive: true });
    // a per-process temp name: two reviews fetching the same ruleset at once must not interleave one file
    const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
    writeFileSync(tmp, body);
    renameSync(tmp, file);
    return { file, state: 'fetched' };
  } catch (e) {
    if (age !== Infinity) return { file, state: `stale, refresh failed: ${e.message}` };
    return { file: null, state: `fetch failed: ${e.message}` };
  }
}

export function rulesetsFor(files) {
  const f = [...files];
  return [
    'p/default',
    'p/secrets',
    ...(f.some((x) => x.endsWith('.go')) ? ['p/golang'] : []),
    ...(f.some((x) => /\.pyi?$/.test(x)) ? ['p/python'] : []),
    ...(f.some((x) => FRONT.test(x)) ? ['p/typescript'] : []),
  ];
}

/** An executable on PATH (+ extra dirs). Windows: .exe only — a .cmd shim would need a shell. */
export function findExe(name, extra = []) {
  const dirs = [...(process.env.PATH ?? '').split(path.delimiter), ...extra].filter(Boolean);
  const ext = process.platform === 'win32' ? '.exe' : '';
  for (const d of dirs) {
    const p = path.join(d, name + ext);
    if (existsSync(p)) return p;
  }
  return null;
}

function killTree(child) {
  if (process.platform === 'win32')
    spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true });
  else child.kill('SIGKILL');
}

/** spawn with a hard deadline (epoch ms); the whole process tree dies at it (semgrep forks semgrep-core). */
function runAsync(cmd, argv, { cwd, env, deadline }) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const left = deadline - t0;
    if (left < 1000) return resolve({ code: null, stdout: '', stderr: '', timedOut: true, ms: 0 });
    let done = false;
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const finish = (r) => {
      if (!done) {
        done = true;
        clearTimeout(timer);
        resolve({ stdout, stderr, timedOut, ms: Date.now() - t0, ...r });
      }
    };
    let child;
    try {
      child = spawn(cmd, argv, { cwd, env: { ...process.env, ...env }, windowsHide: true });
    } catch (e) {
      return resolve({ code: null, error: e, stdout, stderr, ms: 0 });
    }
    const timer = setTimeout(() => {
      timedOut = true;
      killTree(child);
    }, left);
    child.stdout.setEncoding('utf8').on('data', (c) => {
      stdout += c;
    });
    child.stderr.setEncoding('utf8').on('data', (c) => {
      stderr += c;
    });
    child.on('error', (e) => finish({ code: null, error: e }));
    child.on('close', (code) => finish({ code }));
  });
}

const tail = (s, n = 160) =>
  String(s ?? '')
    .trim()
    .split('\n')
    .filter(Boolean)
    .slice(-1)[0]
    ?.trim()
    .slice(0, n) ?? '';
const secs = (ms) => `${(ms / 1000).toFixed(1)}s`;

/** Argument lists under the Windows command-line limit (32 767 chars). */
function chunks(files, max = 20000) {
  const out = [[]];
  let len = 0;
  for (const f of files) {
    if (len + f.length + 3 > max && out.at(-1).length) {
      out.push([]);
      len = 0;
    }
    out.at(-1).push(f);
    len += f.length + 3;
  }
  return out.filter((c) => c.length);
}

async function lintSemgrep({ repo, files, deadline, semgrepConfig, cacheDir }) {
  const r = { tool: 'semgrep', findings: [], notes: [] };
  const targets = files.filter((f) => !TESTISH.test(f)); // security patterns in tests and fixtures are noise
  if (!targets.length) return { ...r, status: 'skipped', why: 'no changed non-test files' };
  const exe = findExe('semgrep');
  if (!exe) return { ...r, status: 'missing', why: 'semgrep not on PATH (pip install semgrep)' };
  let configs;
  if (semgrepConfig)
    configs = semgrepConfig
      .split(',')
      .map((c) => path.resolve(c.trim()))
      .filter(Boolean);
  else {
    const sets = rulesetsFor(targets);
    const got = await Promise.all(sets.map((n) => ensureRuleset(n, { dir: cacheDir })));
    r.notes.push(`rulesets ${sets.map((n, k) => `${n} (${got[k].state})`).join(', ')}`);
    configs = got.map((g) => g.file).filter(Boolean);
    if (!configs.length)
      return { ...r, status: 'failed', why: 'no ruleset could be fetched or found in the cache' };
  }
  const t0 = Date.now();
  for (const c of chunks(targets)) {
    const out = await runAsync(
      exe,
      [
        'scan',
        '--metrics=off',
        '--disable-version-check',
        '--json',
        '--quiet',
        '--timeout',
        '20',
        ...configs.flatMap((x) => ['--config', x]),
        ...c,
      ],
      {
        cwd: repo,
        deadline,
        env: { SEMGREP_SEND_METRICS: 'off', SEMGREP_ENABLE_VERSION_CHECK: '0', PYTHONUTF8: '1' },
      },
    );
    if (out.timedOut)
      return { ...r, status: 'failed', why: `timed out after ${secs(Date.now() - t0)}` };
    let p;
    try {
      p = parseSemgrep(out.stdout);
    } catch {
      return {
        ...r,
        status: 'failed',
        why: `exit ${out.code}: ${tail(out.stderr || out.stdout || out.error?.message)}`,
      };
    }
    r.findings.push(...p.findings.map((f) => ({ ...f, cwd: repo })));
    // exit 0/1 = scanned; anything else (7 missing config, 2 rule parse error) means the rules did not run as given
    if (out.code !== 0 && out.code !== 1)
      return {
        ...r,
        status: 'failed',
        why: `exit ${out.code}: ${(p.errors[0] ?? tail(out.stderr)).slice(0, 160)}`,
      };
    if (p.errors.length)
      r.notes.push(`${p.errors.length} rule errors (${p.errors[0].slice(0, 100)})`);
  }
  return { ...r, status: 'ok', ms: Date.now() - t0 };
}

function moduleRoot(repo, file) {
  let dir = path.dirname(path.join(repo, file));
  const top = path.resolve(repo);
  for (;;) {
    if (existsSync(path.join(dir, 'go.mod'))) return dir;
    if (path.resolve(dir) === top) return null;
    const up = path.dirname(dir);
    if (up === dir) return null;
    dir = up;
  }
}

function hasWorkspace(repo, from) {
  for (let dir = from; ; dir = path.dirname(dir)) {
    if (existsSync(path.join(dir, 'go.work'))) return true;
    if (path.resolve(dir) === path.resolve(repo) || path.dirname(dir) === dir) return false;
  }
}

async function installStaticcheck(goExe, gobin, deadline) {
  const out = await runAsync(goExe, ['install', 'honnef.co/go/tools/cmd/staticcheck@latest'], {
    cwd: os.tmpdir(),
    deadline,
    env: { GOWORK: 'off', GOFLAGS: '' },
  });
  const exe = findExe('staticcheck', [gobin]);
  return exe
    ? {
        exe,
        note: `installed (go install honnef.co/go/tools/cmd/staticcheck@latest, ${secs(out.ms)})`,
      }
    : {
        exe: null,
        why: `go install failed${out.timedOut ? ' (timed out)' : ''}: ${tail(out.stderr || out.error?.message)}`,
      };
}

/** go vet, then staticcheck, per module of the changed Go files; one temp modfile per module (see below). */
async function lintGo({ repo, files, deadline, want, install }) {
  const res = {
    vet: { tool: 'go vet', findings: [], notes: [], ms: 0 },
    staticcheck: { tool: 'staticcheck', findings: [], notes: [], ms: 0 },
  };
  const done = (k, status, why) => Object.assign(res[k], { status, why });
  const goFiles = files.filter((f) => f.endsWith('.go'));
  if (!goFiles.length) {
    for (const k of want) done(k, 'skipped', 'no changed .go files');
    return res;
  }
  const goExe = findExe('go');
  if (!goExe) {
    for (const k of want) done(k, 'missing', 'no go toolchain on PATH');
    return res;
  }
  const env = spawnSync(goExe, ['env', 'GOBIN', 'GOPATH'], {
    encoding: 'utf8',
    windowsHide: true,
  }).stdout.split(/\r?\n/);
  const gobin = env[0]?.trim() || path.join((env[1] ?? '').split(path.delimiter)[0].trim(), 'bin');
  let sc = null;
  if (want.includes('staticcheck')) {
    const exe = findExe('staticcheck', [gobin]);
    sc = exe
      ? Promise.resolve({ exe })
      : install
        ? installStaticcheck(goExe, gobin, deadline)
        : Promise.resolve({ exe: null, why: 'not on PATH (--no-install)' });
  }
  const mods = new Map();
  for (const f of goFiles) {
    const root = moduleRoot(repo, f);
    if (!root) {
      res.vet.notes.push(`${f}: no go.mod above it`);
      continue;
    }
    if (!mods.has(root)) mods.set(root, new Set());
    const rel = path.relative(root, path.dirname(path.join(repo, f))).replace(/\\/g, '/');
    mods.get(root).add(rel ? `./${rel}` : '.');
  }
  const failed = { vet: [], staticcheck: [] };
  let scExe = null;
  for (const [root, pkgSet] of mods) {
    const pkgs = [...pkgSet];
    const name = path.relative(repo, root).replace(/\\/g, '/') || '.';
    // A clone often lacks go.sum (some repos ignore it): -modfile points go at a temp copy of go.mod, so the go.sum
    // it has to complete is written next to the copy, never into the reviewed tree. A go.work governs otherwise.
    const ws = hasWorkspace(repo, root);
    const tmp = ws ? null : mkdtempSync(path.join(os.tmpdir(), 'review-sweep-mod-'));
    if (tmp) {
      copyFileSync(path.join(root, 'go.mod'), path.join(tmp, 'go.mod'));
      if (existsSync(path.join(root, 'go.sum')))
        copyFileSync(path.join(root, 'go.sum'), path.join(tmp, 'go.sum'));
    }
    const flags = tmp ? ['-mod=mod', `-modfile=${path.join(tmp, 'go.mod')}`] : [];
    const goEnv = tmp ? { GOWORK: 'off', GOFLAGS: '' } : {};
    try {
      if (want.includes('vet')) {
        const out = await runAsync(goExe, ['vet', ...flags, '-json', ...pkgs], {
          cwd: root,
          deadline,
          env: goEnv,
        });
        res.vet.ms += out.ms;
        const p = parseVet(`${out.stdout}\n${out.stderr}`);
        res.vet.findings.push(...p.findings.map((f) => ({ ...f, cwd: root })));
        if (out.timedOut) failed.vet.push(`${name}: timed out`);
        else if (out.code !== 0 && !p.findings.length) {
          const all = p.errors.join('\n');
          failed.vet.push(
            GO_DEP_FAIL.test(all)
              ? `${name}: dependencies not downloadable (${tail(
                  all.split('\n').find((l) => GO_DEP_FAIL.test(l)),
                  120,
                )})`
              : `${name}: ${tail(p.errors[0] ?? out.error?.message, 140)}`,
          );
        }
      }
      if (sc) {
        const s = await sc;
        if (!s.exe) {
          if (!res.staticcheck.status) done('staticcheck', 'missing', s.why);
        } else {
          scExe = s.exe;
          if (s.note && !res.staticcheck.notes.includes(s.note)) res.staticcheck.notes.push(s.note);
          // staticcheck loads packages through `go list`: the same modfile rides in GOFLAGS
          const out = await runAsync(s.exe, ['-f', 'json', ...pkgs], {
            cwd: root,
            deadline,
            env: tmp ? { GOWORK: 'off', GOFLAGS: flags.join(' ') } : {},
          });
          res.staticcheck.ms += out.ms;
          const p = parseStaticcheck(out.stdout);
          res.staticcheck.findings.push(...p.findings.map((f) => ({ ...f, cwd: root })));
          if (out.timedOut) failed.staticcheck.push(`${name}: timed out`);
          else if (p.errors.length && !p.findings.length) {
            const all = `${p.errors.join('\n')}\n${out.stderr}`;
            failed.staticcheck.push(
              GO_DEP_FAIL.test(all)
                ? `${name}: dependencies not downloadable`
                : `${name}: ${tail(p.errors[0] || out.stderr, 140)}`,
            );
          } else if (p.errors.length)
            res.staticcheck.notes.push(`${name}: ${p.errors.length} packages did not load`);
        }
      }
    } finally {
      if (tmp) rmSync(tmp, { recursive: true, force: true });
    }
  }
  if (sc && !scExe && !res.staticcheck.status) {
    const s = await sc;
    done('staticcheck', 'missing', s.why);
  }
  for (const k of want) {
    if (res[k].status) continue;
    // every module failed = the tool failed; some = rows from the rest plus a note
    if (failed[k].length && failed[k].length >= mods.size) done(k, 'failed', failed[k].join('; '));
    else {
      res[k].notes.push(...failed[k]);
      done(k, 'ok');
    }
  }
  return res;
}

function uvBinDir() {
  const uv = findExe('uv');
  return uv
    ? spawnSync(uv, ['tool', 'dir', '--bin'], { encoding: 'utf8', windowsHide: true }).stdout.trim()
    : '';
}

async function lintRuff({ repo, files, deadline, install }) {
  const r = { tool: 'ruff', findings: [], notes: [] };
  const py = files.filter((f) => /\.pyi?$/.test(f));
  if (!py.length) return { ...r, status: 'skipped', why: 'no changed .py files' };
  let exe = findExe('ruff', [uvBinDir()].filter(Boolean));
  if (!exe && install) {
    const uv = findExe('uv');
    const pip = findExe('pip') ?? findExe('pip3');
    const how = uv
      ? [uv, ['tool', 'install', 'ruff'], 'uv tool install ruff']
      : pip
        ? [pip, ['install', 'ruff'], 'pip install ruff']
        : null;
    if (!how) return { ...r, status: 'missing', why: 'not on PATH and neither uv nor pip found' };
    const out = await runAsync(how[0], how[1], { cwd: os.tmpdir(), deadline, env: {} });
    exe = findExe('ruff', [uvBinDir()].filter(Boolean));
    if (!exe)
      return {
        ...r,
        status: 'missing',
        why: `${how[2]} failed: ${tail(out.stderr || out.error?.message)}`,
      };
    r.notes.push(`installed (${how[2]}, ${secs(out.ms)})`);
  }
  if (!exe) return { ...r, status: 'missing', why: 'not on PATH (--no-install)' };
  const t0 = Date.now();
  for (const c of chunks(py)) {
    // the project's ruff config applies when it has one; otherwise ruff's default E4/E7/E9/F set
    const out = await runAsync(
      exe,
      ['check', '--output-format=json', '--exit-zero', '--no-fix', ...c],
      { cwd: repo, deadline, env: {} },
    );
    if (out.timedOut)
      return { ...r, status: 'failed', why: `timed out after ${secs(Date.now() - t0)}` };
    let p;
    try {
      p = parseRuff(out.stdout);
    } catch {
      return {
        ...r,
        status: 'failed',
        why: `exit ${out.code}: ${tail(out.stderr || out.error?.message)}`,
      };
    }
    r.findings.push(...p.findings.map((f) => ({ ...f, cwd: repo })));
  }
  return { ...r, status: 'ok', ms: Date.now() - t0 };
}

/** Changed files whose working copy differs from `head` — lint reads the disk, so such a clone would misplace rows. */
export function checkoutDrift(repo, head, files) {
  const r = spawnSync('git', ['-C', repo, 'diff', '--name-only', head], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  if (r.status !== 0) return [`git diff against ${head} failed: ${tail(r.stderr)}`];
  const dirty = new Set(r.stdout.split('\n').filter(Boolean));
  return files.filter((f) => dirty.has(f));
}

/** Run the analyzers in parallel (go vet → staticcheck share one chain), keep rows on added lines only. */
export async function lint({
  repo: given,
  d,
  timeout = 120,
  tools = LINT_TOOLS,
  install = true,
  cap = 15,
  semgrepConfig,
  cacheDir = SEMGREP_CACHE,
  style = false,
}) {
  const t0 = Date.now();
  // The long real path: from an 8.3 short-name cwd (C:\Users\USERNA~1\…) semgrep took 50 s instead of 7.5 s.
  let repo = given;
  try {
    repo = realpathSync.native(given);
  } catch {
    /* keep as given */
  }
  const deadline = t0 + timeout * 1000;
  const idx = addedIndex(d);
  const files = [...idx.keys()].filter((f) => existsSync(path.join(repo, f)));
  const want = (k) => tools.includes(k);
  const goWant = ['vet', 'staticcheck'].filter(want);
  const [sg, go, ruff] = await Promise.all([
    want('semgrep') ? lintSemgrep({ repo, files, deadline, semgrepConfig, cacheDir }) : null,
    goWant.length ? lintGo({ repo, files, deadline, want: goWant, install }) : null,
    want('ruff') ? lintRuff({ repo, files, deadline, install }) : null,
  ]);
  const results = [sg, go?.vet, go?.staticcheck, ruff].filter((x) => x?.status);
  const headers = [];
  const kept = [];
  const toolKey = { semgrep: 'semgrep', 'go vet': 'vet', staticcheck: 'staticcheck', ruff: 'ruff' };
  for (const r of results) {
    const extra = r.notes.length ? ` · ${r.notes.join(' · ')}` : '';
    if (r.status === 'missing') {
      headers.push(`# ${r.tool}: not installed — ${r.why}${extra}`);
      continue;
    }
    if (r.status === 'skipped') {
      headers.push(`# ${r.tool}: skipped — ${r.why}`);
      continue;
    }
    const all = r.findings.map((f) => ({
      ...f,
      tool: toolKey[r.tool],
      file: toRel(f.file, { cwd: f.cwd, repo, files: idx }),
    }));
    const k = keepAdded(all, idx);
    const s = style ? { kept: k.kept, style: 0 } : dropStyle(k.kept);
    k.kept = s.kept;
    kept.push(...k.kept);
    const off =
      (k.outside ? ` · ${k.outside} findings off the added lines dropped` : '') +
      (s.style ? ` · ${s.style} style findings skipped (--style keeps them)` : '');
    if (r.status === 'failed')
      headers.push(
        `# ${r.tool}: failed — ${r.why}${k.kept.length ? ` · ${k.kept.length} rows kept` : ''}${extra}`,
      );
    else headers.push(`# ${r.tool}: ${k.kept.length} rows in ${secs(r.ms ?? 0)}${off}${extra}`);
  }
  const installed = results.flatMap((r) =>
    r.notes.filter((n) => n.startsWith('installed')).map(() => r.tool),
  );
  if (installed.length) headers.push(`# installed this run: ${installed.join(', ')}`);
  headers.push(
    `# lint wall ${secs(Date.now() - t0)} of ${timeout}s · ${files.length} files with added lines`,
  );
  return { headers, rows: capRows(kept, cap), count: kept.length };
}

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  const o = args(rest);
  if (!cmd || !o.base) {
    console.error(
      'usage: review-sweep.mjs sweep|guards|renames|knobs|mutants|lint|all --base <sha> [--head <sha>] [--repo dir] [--paths a,b|@file] [--test <name>] [--cmd "<test cmd>"] [--cap N (0 = all)] [--out file]\n' +
        '  lint/all: [--timeout 120] [--tools semgrep,vet,staticcheck,ruff] [--no-install] [--semgrep-config a.yaml] [--style] [--no-lint (all only)]',
    );
    return 2;
  }
  const repo = path.resolve(o.repo ?? '.');
  const head = o.head ?? 'HEAD';
  // An unknown revision makes `git diff` print nothing: the sweep would report a clean diff of an empty one.
  // A tree id is a readable side too: untracked code is reviewed as HEAD^{tree} vs `git write-tree`.
  const readable = (rev) =>
    ['commit', 'tree'].some(
      (kind) =>
        spawnSync('git', ['-C', repo, 'rev-parse', '--verify', '--quiet', `${rev}^{${kind}}`], {
          encoding: 'utf8',
        }).status === 0,
    );
  for (const rev of [o.base, head]) {
    if (!readable(rev)) {
      console.error(
        `review-sweep: ${rev} is not a commit or tree in ${repo} — a sweep over an unreadable diff is not a clean one`,
      );
      return 2;
    }
  }
  let paths = [];
  let given = 0;
  if (o.paths && o.paths !== true) {
    const changed = git(repo, 'diff', '--name-only', '-z', '-M', o.base, head)
      .split('\0')
      .filter(Boolean);
    const r = resolvePaths(
      pathsArg(o.paths),
      changed,
      (p) =>
        git(repo, 'diff', '--name-only', '-M', o.base, head, '--', p).split('\n').filter(Boolean)
          .length,
    );
    given = r.paths.length + r.unmatched.length;
    if (r.unmatched.length) {
      console.error(
        `review-sweep: --paths names no changed file in ${o.base}..${head}: ${r.unmatched.map((p) => JSON.stringify(p)).join(', ')} — swept 0 of ${given} given. ` +
          'Separate paths with a comma or a newline; a path with spaces needs no quoting. Zero rows over an unmatched path is NOT a clean result.',
      );
      return 2;
    }
    paths = r.paths;
  }
  const d = diffLines(repo, o.base, head, paths);
  const scope = given
    ? ` · paths: ${paths.length} of ${given} given matched, ${d.files.size} files swept`
    : ` · ${d.files.size} files swept`;
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
  if (cmd === 'lint' || (cmd === 'all' && !o['no-lint'])) {
    const drift = checkoutDrift(repo, head, [...addedIndex(d).keys()]);
    if (drift.length && cmd === 'lint') {
      console.error(
        `review-sweep lint: ${repo} is not checked out at ${head} — ${drift.length} changed files differ (${drift.slice(0, 5).join(', ')}). ` +
          'Analyzers read the disk; run lint on a clone at head (git worktree add <dir> <head>).',
      );
      return 2;
    }
    const tools =
      o.tools && o.tools !== true
        ? String(o.tools)
            .split(',')
            .map((s) => s.trim())
            .filter(Boolean)
        : LINT_TOOLS;
    const bad = tools.filter((t) => !LINT_TOOLS.includes(t));
    if (bad.length) {
      console.error(
        `review-sweep lint: unknown --tools ${bad.join(',')} (known: ${LINT_TOOLS.join(',')})`,
      );
      return 2;
    }
    if (drift.length)
      sections.push(
        '## lint — skipped',
        '',
        `# lint: skipped — ${repo} is not checked out at ${head} (${drift.length} changed files differ); run \`lint\` on a clone at head`,
        '',
      );
    else {
      const l = await lint({
        repo,
        d,
        timeout: +(o.timeout ?? 120) || 120,
        tools,
        install: !o['no-install'],
        cap: +(o.cap ?? 15),
        style: !!o.style,
        semgrepConfig:
          o['semgrep-config'] && o['semgrep-config'] !== true ? o['semgrep-config'] : undefined,
      });
      sections.push(
        `## lint — ${l.count}`,
        '',
        ...l.headers,
        ...(l.rows.length ? l.rows : ['none']),
        '',
      );
    }
  }
  if (!sections.length) {
    console.error(`unknown command ${cmd}`);
    return 2;
  }
  const text = [
    `# review-sweep ${cmd} — ${o.base}..${head} · +${d.added.length} −${d.removed.length} lines${scope} · candidates, not findings`,
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
  main().then(
    (code) => {
      process.exitCode = code;
    },
    (e) => {
      console.error(`review-sweep: ${e.message}`);
      process.exitCode = 2;
    },
  );
}
