// Scratch clones and worktrees THIS session created — an agent zone like a temp dir (T11).
//
// A review or a probe often needs the code at another revision, so the agent runs
// `git worktree add --detach <dir> <sha>` or `git clone <url> <dir>`, works there and deletes it.
// Every `rm -rf <dir>/…`, `git clean`, `git checkout -- .` in that directory then asked the human
// for a yes, although the directory exists only because this session made it and holds nothing the
// session did not put there. The session's own transcript is the record of that: the command that
// made the directory is in it. Fails closed (no zone) on anything unreadable or unresolvable.
//
// Narrow on every axis: a literal path (no `$`, no backtick), the directory must exist now and carry
// its own `.git`, and it must be strictly a scratch — never the session cwd, an ancestor of it, the
// main repository of the cwd, the home directory, or a drive root.
//
// A clone `review-plan.mjs plan` made is a scratch root too, though no `git clone` sits in the
// transcript (live 26.10: the parent session's node call made it, the deep-review lane subagent has
// its own transcript, and its `git checkout -- <file>` after a probe in the clone was refused). The
// proof is the mark plan writes after a successful clone, `<clone>/.git/review-plan-scratch.json`:
// it must parse with a string `source` and `head`, the clone must carry `.git/HEAD`, and the same
// filters hold, plus never the clone's own source, an ancestor of it or anything inside it. The
// nearest mark up the path decides; a target whose real path leaves the clone (its node_modules
// links point into the real checkout) is no zone.
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { readTail } from './transcript.mjs';
import { shellWords, slash, repoAt } from './split-worktree.mjs';

const BIG_TAIL = 32 * 1024 * 1024;
const BIG_RECORDS = 20000;
const SHELL_TOOLS = /^(?:Bash|PowerShell)$/;
// `git clone` options whose next word is a value, not the URL or the directory.
const CLONE_VALUE_OPTS =
  /^(?:-b|--branch|--depth|-o|--origin|-c|--config|--reference|--reference-if-able|--separate-git-dir|--template|-j|--jobs|--filter|--shallow-since|--shallow-exclude|-u|--upload-pack|--server-option|--bundle-uri|--revision)$/;
const WORKTREE_VALUE_OPTS = /^(?:-b|-B|--reason)$/;
const REVIEW_MARK = 'review-plan-scratch.json';
const MAX_UP = 64;
const cache = new WeakMap();
const fences = new WeakMap();

const norm = (p) => {
  const n = path.resolve(slash(p));
  return process.platform === 'win32' ? n.toLowerCase() : n;
};
const inside = (child, parent) => {
  const rel = path.relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
};
const literal = (w) => Boolean(w) && !/[$`%]/.test(w);
const realOf = (p) => {
  try {
    return norm(realpathSync.native(p));
  } catch {
    return null;
  }
};
/** `p` under both spellings (as written, real name — 8.3 short names differ). */
const spellings = (p) => [...new Set([norm(p), realOf(p)].filter(Boolean))];

/** `git [-C d] [-c k=v] worktree add …` / `git clone …` → the directory it makes (unresolved), else null. */
function createdDir(words) {
  let i = words.indexOf('git');
  if (i < 0) return null;
  let base = null;
  for (i++; i < words.length; i++) {
    const w = words[i];
    if (w === '-C') {
      base = words[++i];
      if (!literal(base)) return null;
    } else if (w === '-c' || w === '--exec-path' || w === '--namespace') i++;
    else if (w.startsWith('-')) continue;
    else break;
  }
  const sub = words[i];
  const rest = words.slice(i + 1);
  const positional = [];
  const skip = sub === 'clone' ? CLONE_VALUE_OPTS : WORKTREE_VALUE_OPTS;
  let from = 0;
  if (sub === 'worktree') {
    if (rest[0] !== 'add') return null;
    from = 1;
  } else if (sub !== 'clone') return null;
  for (let k = from; k < rest.length; k++) {
    const a = rest[k];
    if (a === '--') continue;
    if (skip.test(a)) k++;
    else if (!a.startsWith('-')) positional.push(a);
  }
  let dir = sub === 'clone' ? positional[1] : positional[0];
  if (sub === 'clone' && !dir && positional[0]) {
    // `git clone <url>` makes ./<repo-name>
    dir = positional[0]
      .replace(/[\\/]+$/, '')
      .replace(/\.git$/, '')
      .split(/[\\/:]/)
      .pop();
  }
  if (!literal(dir)) return null;
  return { dir, base };
}

/** Every directory a Bash command of this transcript created with `git worktree add` / `git clone`. */
function created(input) {
  const out = new Set();
  const sessionCwd = slash(input?.cwd || process.cwd());
  for (const r of readTail(input?.transcript_path, BIG_TAIL, BIG_RECORDS)) {
    const content = r?.type === 'assistant' ? r.message?.content : null;
    if (!Array.isArray(content)) continue;
    for (const c of content) {
      if (
        c?.type !== 'tool_use' ||
        !SHELL_TOOLS.test(c.name) ||
        typeof c.input?.command !== 'string'
      )
        continue;
      let cwd = slash(r.cwd || sessionCwd);
      // Simple commands in order, so `cd /tmp/x && git clone u y` resolves `y` under /tmp/x.
      for (const part of c.input.command.split(/&&|\|\||;|\n|\|/)) {
        const words = shellWords(part.trim());
        if (!words.length) continue;
        if (words[0] === 'cd' || words[0] === 'pushd') {
          cwd = literal(words[1]) ? slash(path.resolve(cwd, slash(words[1]))) : null;
          if (!cwd) break;
          continue;
        }
        const made = createdDir(words);
        if (!made) continue;
        const from = made.base ? path.resolve(cwd, slash(made.base)) : cwd;
        out.add(path.resolve(from, slash(made.dir)));
      }
    }
  }
  return [...out];
}

/** What a scratch root may never be or hold: the cwd, the cwd's main repo, home — both spellings. */
function fence(input) {
  if (fences.has(input)) return fences.get(input);
  const at = input?.cwd || process.cwd();
  const main = repoAt(at);
  const f = {
    cwd: spellings(at),
    main: main ? spellings(main.root) : [],
    home: spellings(homedir()),
  };
  fences.set(input, f);
  return f;
}

/** `d` is a drive root, home, the cwd or the cwd's main repo, or an ancestor of the latter two. */
function fenced(d, input) {
  const f = fence(input);
  return spellings(d).some(
    (n) =>
      path.parse(n).root === n ||
      f.home.includes(n) ||
      f.cwd.some((c) => inside(c, n)) || // the cwd itself or an ancestor of it
      f.main.some((m) => inside(m, n)),
  );
}

/** The live scratch roots of this session (normalised), cached per hook call. */
export function scratchRoots(input) {
  if (cache.has(input)) return cache.get(input);
  let roots;
  try {
    roots = created(input)
      .filter((d) => !fenced(d, input) && existsSync(path.join(d, '.git')))
      .map(norm);
  } catch {
    roots = [];
  }
  cache.set(input, roots);
  return roots;
}

/** The plan mark of `dir`: 'none' when absent, null when unusable, else the parsed mark. */
function reviewMark(dir) {
  const file = path.join(dir, '.git', REVIEW_MARK);
  if (!existsSync(file)) return 'none';
  try {
    const m = JSON.parse(readFileSync(file, 'utf8'));
    if (typeof m?.source !== 'string' || !m.source) return null;
    if (typeof m.head !== 'string' || !m.head) return null;
    if (!existsSync(path.join(dir, '.git', 'HEAD'))) return null;
    // The checkout the clone came from is real work: never the clone, its ancestor or inside it.
    const own = spellings(dir);
    const source = spellings(m.source);
    if (source.some((src) => own.some((n) => inside(n, src) || inside(src, n)))) return null;
    return m;
  } catch {
    return null;
  }
}

/** The real path of `p` or of its nearest existing ancestor (a delete target may not exist yet). */
function realExisting(p) {
  let d = p;
  for (let i = 0; i < MAX_UP; i++) {
    const r = realOf(d);
    if (r) return r;
    const up = path.dirname(d);
    if (up === d) return null;
    d = up;
  }
  return null;
}

/** `abs` sits in a review-plan clone: the nearest mark up the path decides; fails closed. */
function inReviewClone(abs, input) {
  let d = abs;
  for (let i = 0; i < MAX_UP; i++) {
    const m = reviewMark(d);
    if (m === null) return false;
    if (m !== 'none') {
      if (fenced(d, input)) return false;
      const root = realOf(d);
      const at = realExisting(abs);
      return Boolean(root && at && inside(at, root));
    }
    const up = path.dirname(d);
    if (up === d) return false;
    d = up;
  }
  return false;
}

/** `target` is a scratch root of this session or a review-plan clone, or sits inside one. Unknown variables never count. */
export function inScratchZone(target, input) {
  try {
    if (!literal(target)) return false;
    const abs = norm(target);
    if (scratchRoots(input).some((r) => inside(abs, r))) return true;
    return inReviewClone(abs, input);
  } catch {
    return false;
  }
}
