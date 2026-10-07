// Split worktree context — the one fact the git and destructive guards need from a panel split run.
//
// A split launches each agent group in its own git worktree, `<repo>-worktrees/<dir>` beside the
// repository, on a branch named after the group's tickets (`fix/PROJ-1124-PROJ-1142-…`). In a live
// run Door C read the ticket grant only from the USER'S words in the window, and every resume, stage
// prompt, compaction or card answer ("Test + CI fix") carried none — each group stopped on a permission card for commit / push / rebase / cherry-pick of its
// OWN branch, the one thing the split exists to run unattended. The branch the panel created and
// checked out in the group's own worktree is the durable record of the grant: an agent cannot
// forge it without `checkout -b` / `switch -c`, which stay gated.
//
// Narrow on every axis: the directory must be a worktree under `<repo>-worktrees/` (never the main
// clone), the checked-out branch must carry a tracker key, and main/master never qualify. Callers narrow
// further by op and by target. Everything here reads files only — no git process — and fails closed
// (null) on anything it cannot read.
import { readFileSync, statSync } from 'node:fs';
import path from 'node:path';

/** The worktree root of a split group: `…/<repo>-worktrees/<dir>`, nothing below or above it. */
const SPLIT_ROOT = /(?:^|\/)[^/]+-worktrees\/[^/]+$/i;
/** A tracker key in the branch name (`PROJ-123`, `abc-12`). */
const TICKET_ID = /(?<![A-Za-z0-9])[A-Za-z][A-Za-z0-9]{0,9}-\d+(?!\d)/;
const PROTECTED = /^(?:main|master)$/i;

/** Forward-slash native path; Git-Bash `/c/…` → `c:/…` on Windows. */
export function slash(p) {
  let s = String(p ?? '').replace(/\\/g, '/');
  if (process.platform === 'win32') s = s.replace(/^\/([a-z])(?=\/|$)/i, '$1:');
  return s;
}

/** Shell words with quotes removed; adjacent quoted/unquoted parts join (`"$S"/x`). */
export function shellWords(s) {
  const out = [];
  let cur = null;
  for (let i = 0; i < s.length;) {
    const ch = s[i];
    if (/\s/.test(ch)) {
      if (cur !== null) out.push(cur);
      cur = null;
      i++;
    } else if (ch === "'") {
      const j = s.indexOf("'", i + 1);
      const end = j < 0 ? s.length : j;
      cur = (cur ?? '') + s.slice(i + 1, end);
      i = end + 1;
    } else if (ch === '"') {
      let j = i + 1;
      while (j < s.length && s[j] !== '"') j += s[j] === '\\' ? 2 : 1;
      cur = (cur ?? '') + s.slice(i + 1, j);
      i = j + 1;
    } else if (ch === '\\') {
      cur = (cur ?? '') + (s[i + 1] ?? '');
      i += 2;
    } else {
      cur = (cur ?? '') + ch;
      i++;
    }
  }
  if (cur !== null) out.push(cur);
  return out;
}

const readText = (p) => {
  try {
    return readFileSync(p, 'utf8');
  } catch {
    return '';
  }
};

/** Branch checked out in a git dir; mid-rebase HEAD is detached and the branch sits in head-name. */
function headBranch(gitDir) {
  const ref = readText(path.join(gitDir, 'HEAD')).match(/^ref:\s*refs\/heads\/(\S+)/);
  if (ref) return ref[1];
  for (const f of ['rebase-merge/head-name', 'rebase-apply/head-name']) {
    const m = readText(path.join(gitDir, f)).match(/^refs\/heads\/(\S+)/);
    if (m) return m[1];
  }
  return null;
}

/** `{root, branch}` of the repository holding `dir` (walks up to the nearest `.git`), or null. */
export function repoAt(dir) {
  if (!dir) return null;
  let d = path.resolve(slash(dir));
  for (let i = 0; i < 40; i++) {
    const dotGit = path.join(d, '.git');
    let st = null;
    try {
      st = statSync(dotGit);
    } catch {
      /* not here — go up */
    }
    if (st) {
      let gitDir = dotGit;
      if (st.isFile()) {
        const m = readText(dotGit).match(/^gitdir:\s*(.+?)\s*$/m);
        if (!m) return null;
        gitDir = path.resolve(d, m[1]);
      }
      return { root: slash(d), branch: headBranch(gitDir) };
    }
    const up = path.dirname(d);
    if (up === d) return null;
    d = up;
  }
  return null;
}

/** The split group's own `{root, branch}` when `dir` is inside one, else null. */
export function splitBranch(dir) {
  try {
    const repo = repoAt(dir);
    if (!repo?.branch || !SPLIT_ROOT.test(repo.root)) return null;
    if (!TICKET_ID.test(repo.branch) || PROTECTED.test(repo.branch)) return null;
    return repo;
  } catch {
    return null;
  }
}

const sameRoot = (a, b) =>
  process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;

/**
 * The split worktree `dir` belongs to, but only when it is the SESSION'S own one (the hook input's
 * cwd): a group may not act on another group's worktree through `-C`, `cd` or an absolute path.
 */
export function ownSplitAt(dir, sessionCwd) {
  const home = splitBranch(sessionCwd);
  if (!home) return null;
  const there = splitBranch(dir);
  return there && sameRoot(there.root, home.root) ? there : null;
}

export const isProtectedBranch = (b) =>
  PROTECTED.test(String(b ?? '').replace(/^refs\/heads\//, ''));

const CD = /(?:^|[;&|(\n]\s*)(?:cd|pushd)\s+("(?:[^"\\]|\\.)*"|'[^']*'|[^\s;&|()"']+)/g;

const REDIRECT = /^(?:\d+|&)?(?:>>?|<)&?(.*)$/;
/** Shell words minus redirections: `2>&1`, `>/dev/null`, `&>x`, and `2> file` with its target. */
export function dropRedirections(words) {
  const out = [];
  for (let i = 0; i < words.length; i++) {
    const m = REDIRECT.exec(words[i]);
    if (!m) out.push(words[i]);
    else if (!m[1]) i++; // bare operator (`2>`, `>>`, `<`): its target is the next word
  }
  return out;
}

/**
 * The git invocation starting at `at` in `text` (the unblanked command): the directory it runs in —
 * session cwd, then the last `cd` before it, then every `-C` — its subcommand and its arguments.
 * `--git-dir` / `--work-tree` point git somewhere this cannot follow: `dir` null, nobody gets a grant.
 */
export function gitCall(text, at, cwd) {
  let dir = slash(cwd || process.cwd());
  for (const m of text.slice(0, at).matchAll(CD)) {
    const w = shellWords(m[1])[0];
    if (w && !/[$`]/.test(w)) dir = slash(path.resolve(dir, slash(w)));
    else dir = null;
  }
  // `>&`/`&>` are redirections, not the `&` ending a command: cutting at their `&` left `2>`
  // behind as a refspec (seen live — the push went out unsieved).
  const simple = text.slice(at).match(/^(?:>&|&>|[^\n|;&)])*/)[0];
  const words = dropRedirections(shellWords(simple));
  if (words[0] !== 'git') return null;
  let i = 1;
  for (; i < words.length; i++) {
    const w = words[i];
    if (w === '-C') {
      const to = words[++i];
      dir = to && dir && !/[$`]/.test(to) ? slash(path.resolve(dir, slash(to))) : null;
    } else if (w === '-c' || w === '--exec-path' || w === '--namespace') i++;
    else if (/^--(?:git-dir|work-tree)\b/.test(w)) dir = null;
    else if (!w.startsWith('-')) break;
  }
  return { dir, sub: words[i] ?? '', args: words.slice(i + 1) };
}

// --- targets of the ops a split grant covers -------------------------------------------------------

const PUSH_VALUE_OPTS = /^(?:-o|--push-option|--repo|--receive-pack|--exec)$/;
const PUSH_WIDE = /^(?:--all|--mirror|--tags|--delete|-d|--prune|--branches)$/;
const bare = (ref) => String(ref).replace(/^refs\/heads\//, '');

/**
 * Remote branches a `git push` writes, relative to the checked-out `branch`: `HEAD`/no refspec = the
 * branch itself. `null` = cannot be pinned (wide flags, a delete, a `+` force refspec).
 */
export function pushTargets(args, branch) {
  const positional = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (PUSH_VALUE_OPTS.test(a)) i++;
    else if (PUSH_WIDE.test(a)) return null;
    else if (!a.startsWith('-')) positional.push(a);
  }
  const specs = positional.slice(1);
  if (!specs.length) return [branch];
  const out = [];
  for (const spec of specs) {
    if (spec.startsWith('+')) return null;
    const [src, dst] = spec.includes(':') ? spec.split(':', 2) : [spec, spec];
    if (!src) return null; // `:branch` deletes it
    out.push(dst === 'HEAD' || dst === '@' ? branch : bare(dst)); // `@` = HEAD (gitrevisions)
  }
  return out;
}

/**
 * Does this `git pull --rebase` rewrite only the checked-out branch? Positional 1 = repository (a URL
 * may hold `:`), the rest refspecs; a `src:dst` refspec also writes a local `dst`.
 */
export function pullStaysOn(args) {
  const positional = args.filter((a) => !a.startsWith('-'));
  return !positional.slice(1).some((a) => a.includes(':'));
}

const REBASE_VALUE_OPTS = /^(?:--onto|-s|--strategy|-X|--strategy-option|-x|--exec)$/;

/** Does this `git rebase` rewrite only the checked-out branch? (`rebase <upstream> <other>` switches first.) */
export function rebaseStaysOn(args, branch) {
  const positional = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (REBASE_VALUE_OPTS.test(a)) i++;
    else if (!a.startsWith('-')) positional.push(a);
  }
  return positional.length < 2 || bare(positional[1]) === branch;
}
