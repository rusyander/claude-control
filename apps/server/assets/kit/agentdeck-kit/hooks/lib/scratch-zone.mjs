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
import { existsSync } from 'node:fs';
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
const cache = new WeakMap();

const norm = (p) => {
  const n = path.resolve(slash(p));
  return process.platform === 'win32' ? n.toLowerCase() : n;
};
const inside = (child, parent) => {
  const rel = path.relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
};
const literal = (w) => Boolean(w) && !/[$`%]/.test(w);

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

/** The live scratch roots of this session (normalised), cached per hook call. */
export function scratchRoots(input) {
  if (cache.has(input)) return cache.get(input);
  let roots;
  try {
    const cwd = norm(input?.cwd || process.cwd());
    const main = repoAt(input?.cwd || process.cwd());
    const mainRoot = main ? norm(main.root) : null;
    const home = norm(homedir());
    roots = created(input)
      .filter((d) => {
        const n = norm(d);
        if (path.parse(n).root === n || n === home) return false;
        if (inside(cwd, n)) return false; // the cwd itself or an ancestor of it
        if (mainRoot && inside(mainRoot, n)) return false;
        return existsSync(path.join(d, '.git'));
      })
      .map(norm);
  } catch {
    roots = [];
  }
  cache.set(input, roots);
  return roots;
}

/** `target` is a scratch root of this session or sits inside one. Unknown variables never count. */
export function inScratchZone(target, input) {
  try {
    if (!literal(target)) return false;
    const roots = scratchRoots(input);
    if (!roots.length) return false;
    const abs = norm(target);
    return roots.some((r) => inside(abs, r));
  } catch {
    return false;
  }
}
