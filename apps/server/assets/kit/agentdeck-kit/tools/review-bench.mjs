#!/usr/bin/env node
// Seeded-defect recall benchmark for deep-review. A real MR diff gets N small, compiling defects planted on
// its ADDED lines (a recall yardstick needs defects the build cannot catch — a seed the compiler or
// type-check flags is found for free and measures nothing). The seeded tree is a commit made through git
// plumbing only (no checkout, no branch moved) kept under refs/bench/<slug>; the truth lives in the case
// dir, never in the repo, a commit message or a prompt. `prompts` builds lane prompts for base..seededHead
// against a frozen tools snapshot; `score` matches lane candidate lines to the truth (file suffix, ±3 lines)
// and sums the lanes' cost from the subagent transcripts. Cases default to <cwd>/.agent/evals/deep-review
// (the project's own, never committed — the same place review-eval.mjs reads).
//
//   node review-bench.mjs seed --repo <dir> --base <sha> --head <sha> --case <slug> [--n 12] [--rng 1]
//                              [--mr-text <file>] [--scratch <dir>] [--cases <dir>] [--parent head|twin] [--dry]
//   node review-bench.mjs prompts --case <slug> --label <name> --tools <dir> --scratch-root <dir> [--cases <dir>] [--raw]
//                              (writes every lane-round prompt; --raw = tools rewrite only, no fidelity patch)
//   node review-bench.mjs score --case <slug> --label <name> [--session-dir <dir>] [--write] [--cases <dir>]
//
// --parent head (default): the seeded commit's parent is head, as planned. Blindness caveat: `git show
// <seededHead>` then prints exactly the seeds; `--parent twin` gives the commit head's own parents, so
// base..seededHead reads like the original MR with no extra commit.
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  readdirSync,
  rmSync,
  appendFileSync,
  realpathSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HOME = os.homedir();
const CASES = path.join(process.cwd(), '.agent', 'evals', 'deep-review');
/** The kit tools dir this bench runs from — the "live" tools a snapshot replaces. */
const KIT_TOOLS = path.dirname(fileURLToPath(import.meta.url));
const MIN_GAP = 7; // two seeds of one file never share a ±3 match window
const WINDOW = 3;

// ---------------------------------------------------------------- args / git

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

function git(repo, a, { env, input, allowFail = false } = {}) {
  const r = spawnSync('git', ['-C', repo, '-c', 'core.quotepath=false', ...a], {
    encoding: 'utf8',
    maxBuffer: 512 * 1024 * 1024,
    env: env ? { ...process.env, ...env } : process.env,
    input,
  });
  if (r.status !== 0 && !allowFail)
    throw new Error(`git ${a.join(' ')}: ${(r.stderr || '').trim()}`);
  return allowFail ? r : r.stdout;
}

// ---------------------------------------------------------------- PRNG

/** mulberry32: small, deterministic, good enough to shuffle candidates. */
export function rng32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
export function shuffle(arr, rnd) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

// ---------------------------------------------------------------- file eligibility

const TEST_RE =
  /(_test\.go$|\.(test|spec)\.[cm]?[jt]sx?$|(^|\/)(tests?|__tests__|QA|e2e|testdata|fixtures?|__fixtures__|mocks?)\/|(^|\/)test_[^/]*\.py$|_test\.py$|conftest\.py$)/i;
const GEN_RE =
  /((^|\/)sqlcdb\/|\.sql\.go$|\.gen\.|_gen\.go$|\.pb\.go$|zz_generated|(^|\/)(package-lock\.json|yarn\.lock|pnpm-lock\.yaml|go\.sum|poetry\.lock|Cargo\.lock)$|(^|\/)generated\/)/i;
const GEN_HEADER =
  /Code generated|DO NOT EDIT|auto-?generated|собран автоматически|Руками не править/i;

/** The mutation kind of a repo path, or null when the file is never seeded (tests, generated, fixtures, other types). */
export function kindOf(file, headText = '') {
  const f = file.replace(/\\/g, '/');
  if (TEST_RE.test(f) || GEN_RE.test(f)) return null;
  if (headText && GEN_HEADER.test(headText.split('\n').slice(0, 10).join('\n'))) return null;
  if (/\.go$/.test(f)) return 'go';
  if (/\.tsx?$/.test(f) && !/\.d\.ts$/.test(f)) return 'ts';
  if (/\.py$/.test(f)) return 'py';
  if (/\.sql$/.test(f)) return 'sql';
  if (/\.mdx$/.test(f)) return 'doc';
  if (/\.md$/.test(f) && /(^|\/)[\w-]*docs[\w-]*\//i.test(f)) return 'doc';
  if (
    /\.ya?ml$/.test(f) &&
    (/(^|\/)(contracts?|openapi|schemas?)\//i.test(f) || /openapi|swagger/i.test(path.basename(f)))
  )
    return 'contract';
  return null;
}

// ---------------------------------------------------------------- operators

const CLASS = {
  boundary: 'boundary',
  'eq-swap': 'logic-inversion',
  'is-none-swap': 'logic-inversion',
  'swallow-err': 'error-handling',
  'client-error-5xx': 'status-code',
  'drop-sql-filter': 'data-scope',
  'drop-defer': 'resource-release',
  'nullish-or': 'falsy-default',
  'drop-await': 'async',
  'doc-number': 'docs-drift',
  'contract-number': 'contract-drift',
};

const indentOf = (s) => s.match(/^\s*/)[0].length;
const isComment = (kind, t) =>
  kind !== 'doc' &&
  ((kind === 'py' || kind === 'contract'
    ? t.startsWith('#')
    : t.startsWith('//') || t.startsWith('/*') || t.startsWith('*')) ||
    (kind === 'sql' && t.startsWith('--')));
const SWAP_B = { '<': '<=', '<=': '<', '>': '>=', '>=': '>' };
function swapAt(l, re, map) {
  const m = re.exec(l);
  if (!m) return null;
  return `${l.slice(0, m.index)} ${map[m[1]]} ${l.slice(m.index + m[0].length)}`;
}
const IF_GO = /^\s*(\}\s*else\s+)?if\s/;
const LOOP_GO = /^\s*(\}\s*else\s+)?(if|for)\s/;
const IF_TS = /^\s*(\}\s*else\s+)?(if|for|while)\s*\(/;
const IF_PY = /^\s*(if|elif|while)\s/;

/** The nearest preceding non-blank line with a smaller indent: the block opener of lines[idx]. */
function opener(lines, idx) {
  const ind = indentOf(lines[idx]);
  for (let j = idx - 1; j >= 0; j--) {
    const s = lines[j].replace(/\r$/, '');
    if (!s.trim()) continue;
    if (indentOf(s) < ind) return s;
  }
  return null;
}
function prevLine(lines, idx) {
  for (let j = idx - 1; j >= 0; j--) {
    const s = lines[j].replace(/\r$/, '').trim();
    if (s) return s;
  }
  return '';
}

const NUM = (n) => (n === 0 ? 1 : n < 10 ? n + 1 : n * 2);
const UNIT =
  /^(%|сек|секунд|second|sec|ms|мс|мин|minute|min|час|hour|сут|day|дн|дня|недел|week|месяц|month|kb|mb|gb|tb|кб|мб|гб|тб|байт|byte|бит|bit|символ|character|char|знак|token|токен|запрос|request|раз|times|item|элемент|строк|line|row|запис|record|файл|file|попыт|attempt|retr|повтор|пользоват|user|ключ|key|модел|model|страниц|page|soniya|daqiqa|soat|kun|hafta|oy|belgi|bayt|ta\b|so'rov|marta)/i;
const LIMIT_BEFORE =
  /(до|не более|не больше|не менее|максимум|минимум|лимит|предел|порог|каждые|раз в|up to|at most|at least|limit|maximum|minimum|max|min|every|threshold|ko'pi bilan|kamida|gacha|har)\s*$/i;
const NOT_A_QUANTITY = /(?:\b(?:RFC|ISO|HTTP|UTF|IEEE|SQLSTATE|IPv|TK|v)|ТК|№|#)[\s-]*$/i;

/** Prose mask for docs: frontmatter, fenced code, mdx import/export and bare tag lines are not prose. */
export function proseMask(lines) {
  const mask = new Array(lines.length).fill(true);
  let i = 0;
  if (lines[0]?.trim() === '---') {
    mask[0] = false;
    for (i = 1; i < lines.length; i++) {
      mask[i] = false;
      if (lines[i].trim() === '---') {
        i++;
        break;
      }
    }
  }
  let fence = false;
  for (; i < lines.length; i++) {
    const t = lines[i].trim();
    if (/^(```|~~~)/.test(t)) {
      fence = !fence;
      mask[i] = false;
      continue;
    }
    if (fence || /^(import|export)\s/.test(t) || /^<[^>]*>$/.test(t) || t.startsWith('<!--'))
      mask[i] = false;
  }
  return mask;
}

/** One prose number of a doc line changed (a limit, a duration, a size): first quantity-looking number. */
export function docNumber(l) {
  // Blank what is not prose but keeps offsets: inline code, link targets, tags and JSX expressions.
  const blank = (s) =>
    s.replace(/`[^`]*`|\]\([^)]*\)|<[^>]*>|\{[^}]*\}|https?:\/\/\S+/g, (m) => ' '.repeat(m.length));
  const b = blank(l);
  const re = /(?<![\w.,:/#$+\-–])(\d+)(?![\w:/\-–]|[.,]\d)/g;
  for (const m of b.matchAll(re)) {
    const n = Number(m[1]);
    if (n < 2 || (m[1].length === 4 && n >= 1900 && n <= 2099)) continue;
    const before = b.slice(0, m.index);
    if (/^\s*$/.test(before) && /^[.)]\s/.test(b.slice(m.index + m[1].length))) continue; // list marker
    if (NOT_A_QUANTITY.test(before)) continue;
    if (n >= 100 && n <= 599 && /^\s+[A-Z_]{3,}/.test(b.slice(m.index + m[1].length))) continue; // HTTP status
    const after = b.slice(m.index + m[1].length);
    if (!UNIT.test(after.replace(/^\s/, '')) && !LIMIT_BEFORE.test(before)) continue;
    return l.slice(0, m.index) + String(NUM(n)) + l.slice(m.index + m[1].length);
  }
  return null;
}

/**
 * Every operator that applies to lines[idx] of a file of `kind`. Each returns the mutated line, or
 * { drop: true } for a removed line, or null. `ctx.prose` is the docs prose mask.
 */
export const OPERATORS = [
  {
    op: 'boundary',
    kinds: ['go', 'ts', 'py'],
    apply: (l, kind) => {
      const gate = kind === 'go' ? LOOP_GO : kind === 'ts' ? IF_TS : IF_PY;
      return gate.test(l) ? swapAt(l, / (<=|>=|<|>) /, SWAP_B) : null;
    },
  },
  {
    op: 'eq-swap',
    kinds: ['go'],
    apply: (l) =>
      IF_GO.test(l) && !/\berr\s*[!=]=\s*nil\b/.test(l)
        ? swapAt(l, / (==|!=) /, { '==': '!=', '!=': '==' })
        : null,
  },
  {
    op: 'eq-swap',
    kinds: ['ts'],
    apply: (l) =>
      /^\s*import\s/.test(l) ? null : swapAt(l, / (===|!==) /, { '===': '!==', '!==': '===' }),
  },
  {
    op: 'eq-swap',
    kinds: ['py'],
    apply: (l) => swapAt(l, / (==|!=) /, { '==': '!=', '!=': '==' }),
  },
  {
    op: 'is-none-swap',
    kinds: ['py'],
    apply: (l) =>
      /\bis not None\b/.test(l)
        ? l.replace(/\bis not None\b/, 'is None')
        : /\bis None\b/.test(l)
          ? l.replace(/\bis None\b/, 'is not None')
          : null,
  },
  {
    op: 'swallow-err',
    kinds: ['go'],
    apply: (l, kind, lines, idx) => {
      const m = /^(\s*return\b(?:.*[\s,])?)err(\s*)$/.exec(l);
      if (!m) return null;
      const o = opener(lines, idx);
      return o && /^\s*(\}\s*else\s+)?if\b.*\berr\s*!=\s*nil\s*\{\s*$/.test(o)
        ? `${m[1]}nil${m[2]}`
        : null;
    },
  },
  {
    op: 'client-error-5xx',
    kinds: ['go'],
    apply: (l) =>
      /\bhttp\.Status(BadRequest|NotFound|Conflict|UnprocessableEntity)\b/.test(l)
        ? l.replace(
            /\bhttp\.Status(BadRequest|NotFound|Conflict|UnprocessableEntity)\b/,
            'http.StatusInternalServerError',
          )
        : null,
  },
  {
    op: 'drop-sql-filter',
    kinds: ['go', 'sql'],
    apply: (l) => {
      const t = l.trim();
      if (t.includes('`')) return null;
      return /^AND\s+(?:[\w."]+\s*=\s*\$\d+|[\w."]*deleted_at\s+IS\s+NULL|[\w."]*tenant_id\b.*)\s*,?$/i.test(
        t,
      )
        ? { drop: true }
        : null;
    },
  },
  {
    op: 'drop-defer',
    kinds: ['go'],
    apply: (l) =>
      /^\s*defer\s+[\w.]+\.(Close|Unlock|RUnlock)\(\)\s*$/.test(l) ? { drop: true } : null,
  },
  {
    op: 'nullish-or',
    kinds: ['ts'],
    apply: (l) => (/ \?\? /.test(l) ? l.replace(/ \?\? /, ' || ') : null),
  },
  {
    op: 'drop-await',
    kinds: ['ts'],
    apply: (l, kind, lines, idx) => {
      if (!/^\s*await\s+\S/.test(l)) return null;
      const p = prevLine(lines, idx);
      return p === '' || /[;{}]$/.test(p) || p.startsWith('//')
        ? l.replace(/^(\s*)await\s+/, '$1')
        : null;
    },
  },
  {
    op: 'drop-await',
    kinds: ['py'],
    apply: (l, kind, lines, idx) => {
      if (!/^\s*await\s+\S/.test(l)) return null;
      return /[([,=\\]$/.test(prevLine(lines, idx)) ? null : l.replace(/^(\s*)await\s+/, '$1');
    },
  },
  {
    op: 'doc-number',
    kinds: ['doc'],
    apply: (l, kind, lines, idx, ctx) => (ctx?.prose && !ctx.prose[idx] ? null : docNumber(l)),
  },
  {
    op: 'contract-number',
    kinds: ['contract'],
    apply: (l) => {
      const m = /\b(maximum|maxLength|minimum|minLength|default)(\s*:\s*)(\d+)(?![\w.])/.exec(l);
      if (!m) return null;
      const at = m.index + m[1].length + m[2].length;
      return l.slice(0, at) + String(NUM(Number(m[3]))) + l.slice(at + m[3].length);
    },
  },
];

/** Candidates for the given 1-based head lines of one file. */
export function candidatesFor(file, kind, text, headLines) {
  const lines = text.split('\n');
  const ctx = kind === 'doc' ? { prose: proseMask(lines.map((s) => s.replace(/\r$/, ''))) } : {};
  const out = [];
  for (const ln of headLines) {
    const raw = lines[ln - 1];
    if (raw === undefined) continue;
    const eol = raw.endsWith('\r') ? '\r' : '';
    const l = raw.slice(0, raw.length - eol.length);
    if (!l.trim() || isComment(kind, l.trim())) continue;
    for (const o of OPERATORS) {
      if (!o.kinds.includes(kind)) continue;
      const r = o.apply(l, kind, lines, ln - 1, ctx);
      if (r === null || r === l) continue;
      out.push({
        file,
        kind,
        headLine: ln,
        op: o.op,
        class: CLASS[o.op],
        before: l,
        after: r.drop ? null : r + eol,
        drop: !!r.drop,
      });
    }
  }
  return out;
}

// ---------------------------------------------------------------- diff / selection

/** Head-side added line numbers per path from `git diff -U0 -M`. */
export function addedLines(diff) {
  const out = new Map();
  let file = null;
  let hl = 0;
  for (const line of diff.split('\n')) {
    if (line.startsWith('+++ ')) {
      const p = line.slice(4).replace(/^"(.*)"$/, '$1');
      file = p === '/dev/null' ? null : p.replace(/^b\//, '');
      if (file && !out.has(file)) out.set(file, []);
      continue;
    }
    if (line.startsWith('--- ') || line.startsWith('diff --git')) continue;
    const h = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (h) {
      hl = Number(h[1]);
      continue;
    }
    if (!file) continue;
    if (line.startsWith('+')) out.get(file).push(hl++);
  }
  for (const [k, v] of out) if (!v.length) out.delete(k);
  return out;
}

/**
 * Pick up to n candidates: at most 2 per file, ≥ MIN_GAP lines apart, spread by preferring the least-used
 * file + operator; ties go to the PRNG order. `accept(c, picked)` may veto (a seed that breaks the build).
 */
export function pickSeeds(cands, n, rnd, accept = () => true) {
  const order = shuffle([...cands], rnd);
  const picked = [];
  const rejected = new Set();
  const fileN = {};
  const opN = {};
  while (picked.length < n) {
    let best = null;
    let bk = null;
    for (const c of order) {
      if (rejected.has(c) || (fileN[c.file] ?? 0) >= 2) continue;
      if (picked.some((p) => p.file === c.file && Math.abs(p.headLine - c.headLine) < MIN_GAP))
        continue;
      const k = [(fileN[c.file] ?? 0) + (opN[c.op] ?? 0), fileN[c.file] ?? 0];
      if (!best || k[0] < bk[0] || (k[0] === bk[0] && k[1] < bk[1])) {
        best = c;
        bk = k;
      }
    }
    if (!best) break;
    if (accept(best, picked)) {
      picked.push(best);
      fileN[best.file] = (fileN[best.file] ?? 0) + 1;
      opN[best.op] = (opN[best.op] ?? 0) + 1;
    } else rejected.add(best);
  }
  return picked;
}

/** Apply a file's seeds to its head text; returns the text and each seed's seeded-head line. */
export function applySeeds(text, seeds) {
  const lines = text.split('\n');
  const drops = seeds.filter((s) => s.drop).map((s) => s.headLine);
  const placed = seeds.map((s) => {
    const shift = drops.filter((d) => d < s.headLine).length;
    return { ...s, line: s.headLine - shift };
  });
  for (const s of [...seeds].sort((a, b) => b.headLine - a.headLine)) {
    if (s.drop) lines.splice(s.headLine - 1, 1);
    else lines[s.headLine - 1] = s.after;
  }
  const count = lines.length - (lines.at(-1) === '' ? 1 : 0);
  for (const p of placed) if (p.line > count) p.line = count;
  return { text: lines.join('\n'), placed };
}

// ---------------------------------------------------------------- seed

function goModuleRoot(wt, file) {
  let d = path.dirname(path.join(wt, file));
  while (d.length >= wt.length) {
    if (existsSync(path.join(d, 'go.mod'))) return d;
    const up = path.dirname(d);
    if (up === d) break;
    d = up;
  }
  return null;
}
/**
 * Build the packages of `files` in the throwaway worktree. A repo that does not track go.sum gets the
 * checkout's own untracked go.sum copied in, else every build fails on
 * «missing go.sum entry» and that environment error would reject every seed.
 */
function goBuild(wt, files, { repo, env } = {}) {
  const byMod = new Map();
  for (const f of files) {
    const mod = goModuleRoot(wt, f);
    if (!mod) return { ok: false, out: `no go.mod above ${f}` };
    const rel = './' + path.relative(mod, path.dirname(path.join(wt, f))).replace(/\\/g, '/');
    byMod.set(mod, new Set([...(byMod.get(mod) ?? []), rel === './' ? '.' : rel]));
  }
  for (const [mod, pkgs] of byMod) {
    const sum = path.join(repo ?? '', path.relative(wt, mod), 'go.sum');
    if (repo && !existsSync(path.join(mod, 'go.sum')) && existsSync(sum))
      writeFileSync(path.join(mod, 'go.sum'), readFileSync(sum));
    const r = spawnSync('go', ['build', ...pkgs], {
      cwd: mod,
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
      env: { ...process.env, ...env },
    });
    if (r.status !== 0)
      return { ok: false, out: `${mod}: ${(r.stderr || r.stdout || '').trim().slice(0, 800)}` };
  }
  return { ok: true, out: '' };
}
function gofmtOk(file) {
  const r = spawnSync('gofmt', ['-e', '-l', file], { encoding: 'utf8' });
  return { ok: r.status === 0, out: (r.stderr || '').trim().slice(0, 400) };
}
function removeWorktree(repo, wt) {
  git(repo, ['worktree', 'remove', '--force', wt], { allowFail: true });
  if (existsSync(wt)) rmSync(wt, { recursive: true, force: true });
  git(repo, ['worktree', 'prune'], { allowFail: true });
}

function seed(o) {
  for (const k of ['repo', 'base', 'head', 'case'])
    if (!o[k] || o[k] === true) throw new Error(`seed needs --${k}`);
  const repo = path.resolve(o.repo);
  const base = git(repo, ['rev-parse', '--verify', `${o.base}^{commit}`]).trim();
  const head = git(repo, ['rev-parse', '--verify', `${o.head}^{commit}`]).trim();
  const n = Number(o.n ?? 12);
  const rngSeed = Number(o.rng ?? 1);
  const slug = String(o.case);
  if (!/^[\w.-]+$/.test(slug)) throw new Error(`--case ${slug}: letters, digits, . _ - only`);
  const caseDir = path.join(path.resolve(String(o.cases ?? CASES)), slug);
  const scratch = path.resolve(String(o.scratch ?? path.join(os.tmpdir(), 'review-bench')));
  mkdirSync(scratch, { recursive: true });

  const added = addedLines(
    git(repo, ['diff', '-U0', '-M', '--no-color', '--no-ext-diff', base, head]),
  );
  const texts = new Map();
  const cands = [];
  for (const [file, lns] of added) {
    if (!kindOf(file)) continue;
    const text = git(repo, ['cat-file', 'blob', `${head}:${file}`]);
    const kind = kindOf(file, text);
    if (!kind) continue;
    texts.set(file, text);
    cands.push(...candidatesFor(file, kind, text, lns));
  }
  console.log(
    `candidates: ${cands.length} on ${new Set(cands.map((c) => c.file)).size} files (${Object.entries(
      cands.reduce((a, c) => ((a[c.op] = (a[c.op] ?? 0) + 1), a), {}),
    )
      .map(([k, v]) => `${k} ${v}`)
      .join(', ')})`,
  );
  if (o.dry) {
    // candidates only: nothing written, no worktree, no ref
    for (const c of cands)
      console.log(
        `  ${c.file}:${c.headLine} ${c.op} | ${c.before.trim().slice(0, 120)} => ${c.drop ? '<dropped>' : c.after.trim().slice(0, 120)}`,
      );
    return 0;
  }

  // Go seeds are validated one by one in a throwaway worktree at head (gofmt -e + go build of the package).
  const wt = path.join(scratch, 'wt');
  const hasGo = cands.some((c) => c.kind === 'go');
  const rejects = [];
  let goEnv = {};
  if (hasGo) {
    removeWorktree(repo, wt);
    git(repo, ['worktree', 'add', '--detach', '--quiet', wt, head]);
  }
  try {
    if (hasGo) {
      // Baseline: unmodified head must build, else a build failure says nothing about a seed. Fallback
      // for a module without any go.sum: let go resolve sums from the module cache (throwaway tree only).
      const goFiles = [...new Set(cands.filter((c) => c.kind === 'go').map((c) => c.file))];
      let b = goBuild(wt, goFiles, { repo });
      if (!b.ok) {
        goEnv = { GOFLAGS: '-mod=mod', GOSUMDB: 'off' };
        b = goBuild(wt, goFiles, { repo, env: goEnv });
      }
      if (!b.ok) {
        console.log(
          `go baseline at head does not build — Go seeds skipped: ${b.out.split('\n')[0]}`,
        );
        cands.splice(0, cands.length, ...cands.filter((c) => c.kind !== 'go'));
      } else
        console.log(
          `go baseline: head builds (${[...new Set(goFiles.map((f) => path.dirname(f)))].join(', ')})${goEnv.GOFLAGS ? ' with GOFLAGS=-mod=mod GOSUMDB=off' : ''}`,
        );
    }
    const accept = (c, picked) => {
      if (c.kind !== 'go') return true;
      const mine = [...picked.filter((p) => p.file === c.file), c];
      const target = path.join(wt, c.file);
      writeFileSync(target, applySeeds(texts.get(c.file), mine).text);
      const fmt = gofmtOk(target);
      const b = fmt.ok ? goBuild(wt, [c.file], { repo, env: goEnv }) : fmt;
      if (!b.ok) {
        writeFileSync(target, applySeeds(texts.get(c.file), mine.slice(0, -1)).text);
        rejects.push(`${c.file}:${c.headLine} ${c.op} — ${b.out.split('\n')[0]}`);
      }
      return b.ok;
    };
    const picked = pickSeeds(cands, n, rng32(rngSeed), accept);
    if (!picked.length) throw new Error('no seedable added line in this diff');
    if (picked.length < n) console.log(`only ${picked.length} of ${n} seeds placeable`);

    // Seeded commit via plumbing: temp index, blobs, tree, commit-tree; refs/bench/<slug> keeps it.
    const byFile = new Map();
    for (const p of picked) byFile.set(p.file, [...(byFile.get(p.file) ?? []), p]);
    const index = path.join(scratch, `index-${slug}`);
    rmSync(index, { force: true });
    const env = { GIT_INDEX_FILE: index };
    git(repo, ['read-tree', head], { env });
    const truth = [];
    for (const [file, seeds] of byFile) {
      const { text, placed } = applySeeds(texts.get(file), seeds);
      const blob = git(repo, ['hash-object', '-w', '--stdin', '--no-filters'], {
        input: text,
      }).trim();
      const mode = git(repo, ['ls-tree', head, '--', file]).split(/\s/)[0];
      git(repo, ['update-index', '--cacheinfo', `${mode},${blob},${file}`], { env });
      for (const p of placed)
        truth.push({
          file,
          line: p.line,
          headLine: p.headLine,
          op: p.op,
          class: p.class,
          before: p.before,
          after: p.drop ? null : p.after.replace(/\r$/, ''),
        });
    }
    const tree = git(repo, ['write-tree'], { env }).trim();
    rmSync(index, { force: true });
    const meta = git(repo, [
      'log',
      '-1',
      '--format=%an%x00%ae%x00%aI%x00%cn%x00%ce%x00%cI%x00%P%x00%B',
      head,
    ]).split('\0');
    const parents = o.parent === 'twin' ? meta[6].trim().split(/\s+/).filter(Boolean) : [head];
    const cenv = {
      GIT_AUTHOR_NAME: meta[0],
      GIT_AUTHOR_EMAIL: meta[1],
      GIT_AUTHOR_DATE: meta[2],
      GIT_COMMITTER_NAME: meta[3],
      GIT_COMMITTER_EMAIL: meta[4],
      GIT_COMMITTER_DATE: meta[5],
    };
    const seededHead = git(
      repo,
      ['commit-tree', tree, ...parents.flatMap((p) => ['-p', p]), '-F', '-'],
      { env: cenv, input: meta.slice(7).join('\0') },
    ).trim();
    git(repo, ['update-ref', `refs/bench/${slug}`, seededHead]);

    // Final check: the whole seeded tree builds, and every truth line reads back as seeded.
    if (hasGo && picked.some((p) => p.kind === 'go')) {
      git(repo, ['-C', wt, 'checkout', '--detach', '--force', '--quiet', seededHead]);
      const goFiles = [...byFile.keys()].filter((f) => kindOf(f) === 'go');
      const b = goBuild(wt, goFiles, { repo, env: goEnv });
      if (!b.ok) throw new Error(`seeded tree does not build: ${b.out}`);
      console.log(
        `build: go build of ${[...new Set(goFiles.map((f) => path.dirname(f)))].join(', ')} at ${seededHead.slice(0, 12)} — ok`,
      );
    }
    truth.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
    truth.forEach((t, i) => {
      t.id = `S${String(i + 1).padStart(2, '0')}`;
    });
    const bad = [];
    for (const t of truth) {
      const lines = git(repo, ['cat-file', 'blob', `${seededHead}:${t.file}`]).split('\n');
      if (!added.get(t.file)?.includes(t.headLine))
        bad.push(`${t.id} head line ${t.headLine} not added by the diff`);
      if (t.after !== null && lines[t.line - 1]?.replace(/\r$/, '') !== t.after)
        bad.push(`${t.id} seeded line ${t.line} reads «${lines[t.line - 1]}»`);
    }
    if (bad.length) throw new Error(`truth does not match the seeded tree:\n${bad.join('\n')}`);

    mkdirSync(caseDir, { recursive: true });
    const c = {
      id: slug,
      repo: repo.replace(/\\/g, '/'),
      base,
      head,
      seededHead,
      kind: 'seeded',
      parent: o.parent === 'twin' ? 'twin' : 'head',
      rng: rngSeed,
      n,
    };
    if (o['mr-text'] && o['mr-text'] !== true) {
      const body = readFileSync(String(o['mr-text']), 'utf8').replace(/^<!-- lang:ru -->\r?\n/, '');
      writeFileSync(path.join(caseDir, 'mr-text.md'), `<!-- lang:ru -->\n${body}`);
      c.mrText = 'mr-text.md';
    }
    writeFileSync(path.join(caseDir, 'case.json'), JSON.stringify(c, null, 1) + '\n');
    writeFileSync(
      path.join(caseDir, 'truth.json'),
      JSON.stringify(
        truth.map((t) => ({
          id: t.id,
          file: t.file,
          line: t.line,
          op: t.op,
          class: t.class,
          before: t.before,
          after: t.after,
          headLine: t.headLine,
        })),
        null,
        1,
      ) + '\n',
    );
    for (const r of rejects) console.log(`rejected (build): ${r}`);
    for (const t of truth) console.log(`${t.id} ${t.file}:${t.line} ${t.op} [${t.class}]`);
    console.log(
      `verified: ${truth.length} seeds, each on an added head line, each reads back at its seeded line`,
    );
    console.log(
      `seededHead ${seededHead} (refs/bench/${slug}, parent ${c.parent === 'twin' ? 'twin of head' : head.slice(0, 12)})`,
    );
    console.log(`→ ${caseDir}`);
    return 0;
  } finally {
    if (hasGo) removeWorktree(repo, wt);
  }
}

// ---------------------------------------------------------------- prompts

const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const fwd = (p) => String(p).replace(/\\/g, '/').replace(/\/+$/, '');
/**
 * Every spelling of the live tools dir `live` (default: the kit tools dir this bench runs from): absolute
 * with either slash (C:/a/b, C:\a\b), the Git Bash form (/c/a/b), and — when it lies under `home` — `~/…`
 * and `$HOME/…`. Case-insensitive; a sibling dir (`tools-baseline`) is not it.
 */
export function liveToolsRe(live = KIT_TOOLS, home = HOME) {
  const sep = '[\\\\/]+';
  const parts = (p) => fwd(p).split('/').filter(Boolean).map(esc);
  const abs = parts(live);
  const drive = /^([A-Za-z]):$/.exec(abs[0] ?? '')?.[1];
  const roots = drive
    ? [abs.join(sep), `/${drive}${sep}${abs.slice(1).join(sep)}`]
    : [`/${abs.join(sep)}`];
  const h = fwd(home);
  if (h && fwd(live).toLowerCase().startsWith(`${h.toLowerCase()}/`)) {
    const rest = parts(fwd(live).slice(h.length)).join(sep);
    roots.push(`~${sep}${rest}`, `\\$HOME${sep}${rest}`);
  }
  return new RegExp(`(?:${roots.join('|')})(?![\\w-])`, 'gi');
}
/** `--tools` names the live tools dir (case-, slash- and 8.3-insensitive via realpath). */
export function isLiveTools(tools, live = KIT_TOOLS) {
  const norm = (p) => {
    let r = path.resolve(String(p));
    try {
      r = realpathSync.native(r);
    } catch {
      /* keep as given */
    }
    return r.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
  };
  return norm(tools) === norm(live);
}
export function rewriteTools(text, tools, live = KIT_TOOLS, home = HOME) {
  const to = fwd(tools);
  let n = 0;
  const out = text.replace(liveToolsRe(live, home), () => {
    n++;
    return to;
  });
  return { text: out, n };
}

const readCase = (o) => {
  if (!o.case || o.case === true) throw new Error('needs --case <slug>');
  const dir = path.join(path.resolve(String(o.cases ?? CASES)), String(o.case));
  const f = path.join(dir, 'case.json');
  if (!existsSync(f)) throw new Error(`no case: ${f}`);
  return { dir, c: JSON.parse(readFileSync(f, 'utf8')) };
};

function prompts(o) {
  const { dir, c } = readCase(o);
  for (const k of ['label', 'tools', 'scratch-root'])
    if (!o[k] || o[k] === true) throw new Error(`prompts needs --${k}`);
  const tools = path.resolve(String(o.tools));
  const planTool = path.join(tools, 'review-plan.mjs');
  if (!existsSync(planTool)) throw new Error(`no ${planTool}`);
  // Neutral slug: lanes see it in every path, and a word naming the benchmark tells them seeds exist.
  const slug = `${c.id}-${o.label}`;
  const runDir = path.join(c.repo, '.agent', 'tmp', `review-${slug}`);
  const out = path.join(runDir, 'plan');
  mkdirSync(runDir, { recursive: true });
  const a = [
    'plan',
    '--repo',
    c.repo,
    '--base',
    c.base,
    '--head',
    c.seededHead,
    '--slug',
    slug,
    '--out',
    out,
    '--scratch-root',
    path.resolve(String(o['scratch-root'])),
  ];
  let scope = `commits ${c.head.slice(0, 10)}`;
  if (c.mrText && existsSync(path.join(dir, c.mrText))) {
    // The prompt gets the MR text without the agent-doc marker; the case dir keeps the marked copy.
    const body = readFileSync(path.join(dir, c.mrText), 'utf8').replace(
      /^<!-- lang:ru -->\r?\n/,
      '',
    );
    const f = path.join(runDir, 'mr-text.txt');
    writeFileSync(f, body);
    a.push('--mr-text', f);
    scope =
      body
        .split('\n')
        .find((s) => s.trim())
        ?.trim() || scope;
  }
  a.push('--scope', scope);
  const runPlan = (extra = []) =>
    spawnSync(process.execPath, [planTool, ...a, ...extra], {
      cwd: c.repo,
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
    });
  let r = runPlan();
  if (r.status !== 0 && /tests?-record/i.test(r.stderr + r.stdout)) {
    const rec = path.join(runDir, 'tests-record.txt');
    writeFileSync(rec, 'bench: suite not run\n');
    r = runPlan(['--tests-record', rec]);
  }
  if (r.status !== 0) throw new Error(`review-plan failed (${r.status}):\n${r.stderr || r.stdout}`);
  // Rounds 2+ are made now by the same frozen review-plan (`prompt --round k`), so the whole run uses the
  // snapshot; a later `review-plan prompt` from the live tools would print the live paths again.
  const plan = JSON.parse(readFileSync(path.join(out, 'plan.json'), 'utf8'));
  for (const l of plan.lanes) {
    for (let k = 2; k <= (l.rounds?.length ?? 1); k++) {
      const pr = spawnSync(
        process.execPath,
        [
          planTool,
          'prompt',
          '--plan',
          path.join(out, 'plan.json'),
          '--lane',
          l.id,
          '--round',
          String(k),
        ],
        { cwd: c.repo, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
      );
      if (pr.status !== 0)
        throw new Error(
          `review-plan prompt --lane ${l.id} --round ${k}: ${pr.stderr || pr.stdout}`,
        );
      writeFileSync(path.join(out, `lane-${l.id}-r${k}.prompt.md`), pr.stdout);
    }
  }
  const files = readdirSync(out)
    .filter((f) => f.endsWith('.prompt.md'))
    .sort((a, b) => a.localeCompare(b, 'en', { numeric: true }))
    .map((f) => path.join(out, f));
  const clone = plan.scratch?.dir;
  let total = 0;
  let pinned = 0;
  for (const f of files) {
    let { text, n } = rewriteTools(readFileSync(f, 'utf8'), tools);
    total += n;
    if (!o.raw) {
      const fx = benchFidelity(text, { head: c.seededHead, repo: c.repo, clone });
      text = fx.text;
      pinned += fx.pinned;
    }
    writeFileSync(f, text);
    // A candidate run measures the live tools themselves (`--tools` = the kit tools dir itself): their paths are the target.
    const left = isLiveTools(tools) ? 0 : (text.match(liveToolsRe()) ?? []).length;
    if (left) throw new Error(`${f}: ${left} live tools reference(s) left`);
  }
  const stdout = rewriteTools(r.stdout, tools).text;
  console.log(stdout.trimEnd());
  console.log(
    `tools: ${total} reference(s) to the live tools dir rewritten to ${tools.replace(/\\/g, '/')} in ${files.length} prompt file(s); 0 left`,
  );
  if (!o.raw)
    console.log(
      `fidelity: ${pinned} sweep call(s) pinned to --head ${c.seededHead.slice(0, 12)}; one line per prompt points whole-file reads at the clone (the checkout ${c.repo} is not at the seeded head) — --raw skips both`,
    );
  const stub = /stub «(.*?)»/.exec(stdout)?.[1];
  for (const f of files)
    console.log(
      `stub ${path.basename(f)}: ${stub ? stub.replace('<lane prompt file above>', f) : f}`,
    );
  return 0;
}

/**
 * A bench run reviews seededHead while the lanes' cwd is the user's checkout on some other commit. In a
 * real review the checkout IS head, so review-plan prints sweeps with --base only (head = HEAD) and lets
 * lanes read files from the checkout; here both would read an unseeded tree. Pin each base-only sweep to
 * --head, and add one neutral line naming the clone (already at head) as the tree to read.
 */
export function benchFidelity(text, { head, repo, clone }) {
  let pinned = 0;
  let out = text.replace(
    /(review-sweep\.mjs\s+\w+\s+--base\s+[0-9a-f]{7,40})(?![^\n`]*--head)/g,
    (m) => {
      pinned++;
      return `${m} --head ${head}`;
    },
  );
  if (clone && !out.includes('read whole files from')) {
    const line = `The checkout ${repo} is on another commit: read whole files from ${clone} (a clone at head ${head.slice(0, 12)}) or with \`git show ${head.slice(0, 12)}:<path>\`, never from ${repo} paths.`;
    out = out.replace(/^(The reviewed tree stays untouched:[^\n]*)$/m, `$1\n${line}`);
    if (!out.includes(line)) out += `\n${line}\n`;
  }
  return { text: out, pinned };
}

// ---------------------------------------------------------------- score

const REF_RE = /`?((?:[A-Za-z]:)?[\w@./\\-]*[\w-]\.[A-Za-z]\w*):(\d+)(?:\s*[-–]\s*(\d+))?`?/g;
const NEW_RE = /^\s*[-*]\s+C[A-Za-z]*\d+\s+·\s+`?([^\s`·]+?):(\d+)(?:[-–](\d+))?`?\s+·/;

/** Candidate lines of a lane report, each with the sites it cites. */
export function parseCandidates(text, source = '') {
  const out = [];
  for (const raw of text.split('\n')) {
    const line = raw.replace(/\r$/, '');
    const nm = NEW_RE.exec(line);
    if (nm) {
      out.push({ source, line, refs: [{ path: nm[1], from: +nm[2], to: +(nm[3] ?? nm[2]) }] });
      continue;
    }
    const t = line.trim();
    if (!t.includes(' · ') || t.startsWith('|') || t.includes('clean —')) continue;
    const refs = [...t.matchAll(REF_RE)].map((m) => ({
      path: m[1],
      from: +m[2],
      to: +(m[3] ?? m[2]),
    }));
    if (refs.length) out.push({ source, line: t, refs });
  }
  return out;
}

const norm = (p) => p.replace(/\\/g, '/').replace(/^\.\//, '').replace(/^\/+/, '');
/** Same file: one path is a suffix of the other on a segment boundary. */
export function sameFile(cited, truthFile) {
  const a = norm(cited).toLowerCase();
  const b = norm(truthFile).toLowerCase();
  if (a === b) return true;
  return (
    (b.endsWith(a) && b[b.length - a.length - 1] === '/') ||
    (a.endsWith(b) && a[a.length - b.length - 1] === '/')
  );
}
export function matchTruth(truth, cands, window = WINDOW) {
  return truth.map((t) => {
    for (const c of cands) {
      for (const r of c.refs) {
        if (
          sameFile(r.path, t.file) &&
          t.line >= Math.min(r.from, r.to) - window &&
          t.line <= Math.max(r.from, r.to) + window
        ) {
          return { ...t, caught: true, by: c, wide: Math.abs(r.to - r.from) > 15 };
        }
      }
    }
    return { ...t, caught: false };
  });
}

/** Cost of the subagents whose first user message names the run: tokens once per assistant message.id. */
export function sessionCost(dir, runRe) {
  const agents = [];
  for (const f of readdirSync(dir)
    .filter((x) => x.endsWith('.jsonl'))
    .sort()) {
    const rows = readFileSync(path.join(dir, f), 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((s) => {
        try {
          return JSON.parse(s);
        } catch {
          return null;
        }
      })
      .filter(Boolean);
    const first = rows.find((x) => x.type === 'user' && x.message?.role === 'user');
    if (!first || !runRe.test(JSON.stringify(first.message.content))) continue;
    const usage = new Map();
    const tools = new Set();
    let t0 = Infinity;
    let t1 = -Infinity;
    for (const x of rows) {
      const ts = Date.parse(x.timestamp ?? '');
      if (!Number.isNaN(ts)) {
        t0 = Math.min(t0, ts);
        t1 = Math.max(t1, ts);
      }
      if (x.type !== 'assistant' || !x.message?.id) continue;
      if (x.message.usage) usage.set(x.message.id, x.message.usage);
      for (const b of x.message.content ?? []) if (b?.type === 'tool_use') tools.add(b.id);
    }
    const u = [...usage.values()];
    const sum = (k) => u.reduce((s, v) => s + (v[k] ?? 0), 0);
    const a = {
      file: f,
      turns: usage.size,
      toolCalls: tools.size,
      input: sum('input_tokens'),
      output: sum('output_tokens'),
      cacheCreate: sum('cache_creation_input_tokens'),
      cacheRead: sum('cache_read_input_tokens'),
      peakContext: u.reduce(
        (m, v) =>
          Math.max(
            m,
            (v.input_tokens ?? 0) +
              (v.cache_creation_input_tokens ?? 0) +
              (v.cache_read_input_tokens ?? 0),
          ),
        0,
      ),
      t0,
      t1,
    };
    a.tokens = a.input + a.output + a.cacheCreate + a.cacheRead;
    agents.push(a);
  }
  const tot = (k) => agents.reduce((s, a) => s + a[k], 0);
  const t0 = Math.min(...agents.map((a) => a.t0));
  const t1 = Math.max(...agents.map((a) => a.t1));
  return {
    spawns: agents.length,
    tokens: tot('tokens'),
    input: tot('input'),
    output: tot('output'),
    cacheCreate: tot('cacheCreate'),
    cacheRead: tot('cacheRead'),
    turns: tot('turns'),
    toolCalls: tot('toolCalls'),
    toolsPerTurn: tot('turns') ? +(tot('toolCalls') / tot('turns')).toFixed(2) : 0,
    peakContext: agents.reduce((m, a) => Math.max(m, a.peakContext), 0),
    wallMinutes: agents.length && Number.isFinite(t0) ? +((t1 - t0) / 60000).toFixed(1) : 0,
    agents: agents.map(({ t0: _t0, t1: _t1, ...rest }) => rest),
  };
}

function score(o) {
  const { dir, c } = readCase(o);
  if (!o.label || o.label === true) throw new Error('score needs --label');
  const runDir = path.join(c.repo, '.agent', 'tmp', `review-${c.id}-${o.label}`);
  if (!existsSync(runDir)) throw new Error(`no run dir ${runDir}`);
  const files = readdirSync(runDir)
    .filter((f) => !f.endsWith('.prompt.md') && (/^lane-.*\.md$/.test(f) || /-r\d*.*\.md$/.test(f)))
    .sort();
  const cands = files.flatMap((f) =>
    parseCandidates(readFileSync(path.join(runDir, f), 'utf8'), f),
  );
  const truth = JSON.parse(readFileSync(path.join(dir, 'truth.json'), 'utf8'));
  const res = matchTruth(truth, cands);
  for (const r of res) {
    console.log(
      `${r.id} ${r.caught ? 'caught' : 'missed'} ${r.file}:${r.line} ${r.op} [${r.class}]${r.caught ? `${r.wide ? ' (wide range)' : ''}\n    ${r.by.source}: ${r.by.line.slice(0, 240)}` : ''}`,
    );
  }
  const caught = res.filter((r) => r.caught).length;
  const perClass = {};
  for (const r of res) {
    perClass[r.class] ??= { caught: 0, total: 0 };
    perClass[r.class].total++;
    if (r.caught) perClass[r.class].caught++;
  }
  console.log(
    `recall ${caught}/${res.length} (${res.length ? Math.round((100 * caught) / res.length) : 0}%)`,
  );
  console.log(
    `per class: ${Object.entries(perClass)
      .map(([k, v]) => `${k} ${v.caught}/${v.total}`)
      .join(' · ')}`,
  );
  console.log(
    `candidate lines: ${cands.length} in ${files.length} file(s) (${files.map((f) => `${f} ${cands.filter((x) => x.source === f).length}`).join(', ')})`,
  );
  let cost = null;
  if (o['session-dir'] && o['session-dir'] !== true) {
    cost = sessionCost(
      path.resolve(String(o['session-dir'])),
      new RegExp(`review-${esc(c.id)}-${esc(String(o.label))}(?![\\w-])`),
    );
    console.log(
      `cost: ${cost.spawns} spawn(s) · ${cost.tokens} tokens (in ${cost.input}, out ${cost.output}, cache write ${cost.cacheCreate}, cache read ${cost.cacheRead}) · ${cost.turns} turns · ${cost.toolCalls} tool calls (${cost.toolsPerTurn}/turn) · peak context ${cost.peakContext} · wall ${cost.wallMinutes} min`,
    );
  }
  if (o.write) {
    const row = {
      ts: new Date().toISOString(),
      case: c.id,
      label: String(o.label),
      seededHead: c.seededHead,
      caught,
      total: res.length,
      recall: res.length ? +(caught / res.length).toFixed(3) : 0,
      perClass,
      candidates: cands.length,
      files,
      missed: res.filter((r) => !r.caught).map((r) => r.id),
      cost: cost && { ...cost, agents: undefined },
    };
    appendFileSync(path.join(dir, 'history.jsonl'), JSON.stringify(row) + '\n');
    console.log(`→ ${path.join(dir, 'history.jsonl')}`);
  }
  return 0;
}

// ---------------------------------------------------------------- main

function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  const o = args(rest);
  if (cmd === 'seed') return seed(o);
  if (cmd === 'prompts') return prompts(o);
  if (cmd === 'score') return score(o);
  console.error(
    'usage: review-bench.mjs seed --repo <dir> --base <sha> --head <sha> --case <slug> [--n 12] [--rng 1] [--mr-text f] [--scratch <dir>] [--parent head|twin] | prompts --case <slug> --label <name> --tools <dir> --scratch-root <dir> | score --case <slug> --label <name> [--session-dir <dir>] [--write]  (all: [--cases <dir>])',
  );
  return 2;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    process.exitCode = main();
  } catch (e) {
    console.error(`review-bench: ${e.message}`);
    process.exitCode = 2;
  }
}
