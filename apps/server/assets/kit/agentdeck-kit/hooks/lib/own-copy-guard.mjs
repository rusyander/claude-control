// PreToolUse(Bash|PowerShell), split group only (AGENTDECK_SPLIT_CHILD=1): a group runs a dev server, a
// build or a shot script only from its own copy.
//
// Watch audit 25.10, finding 5: at the end of the work stage the group took its BEFORE shots from the
// user's MAIN checkout — `npm --prefix <main>/web-ui run dev -- --port 5180` beside its own copy on
// :5181. Main's sources already imported a symbol its stale sibling-package `dist` lacked, the dev server
// failed on `No matching export … parsePermission`, both BEFORE shots came out blank (two retakes,
// ~3 min), and Vite wrote its dependency cache into a tree the group does not own. Main is not even the
// pre-change tree: the base of the branch is a commit, not whatever the user's checkout holds now.
//
// Refused: a package-manager script named like dev/build/start/preview/serve/storybook/watch or *shot*
// (`npm|pnpm|yarn|bun [run] <script>`, with `--prefix` / `-C` / `--dir` / `--cwd`), a dev tool binary
// (vite, next, webpack, playwright, storybook, …) bare or through npx/exec/dlx, and `node <script>`
// whose script is a shot script — when the directory it runs in sits in a git tree other than the
// copy: the user's main checkout, a sibling group's worktree, any other repository. The directory is
// the session cwd, then each literal `cd`/`pushd`/`Set-Location`, then the runner's own dir option.
// Own: anything inside the copy (a base tree unpacked into `<copy>/.agent/tmp/` included) and a scratch
// worktree/clone THIS session created (scratch-zone.mjs). A directory in no git tree (a temp probe)
// and an unresolvable one (`$VAR`) are not judged. No repeat escape: nobody in a group needs the
// foreign tree, and the refusal names the way to the pre-change tree.
import { realpathSync } from 'node:fs';
import path from 'node:path';
import { deny } from './transcript.mjs';
import { repoAt, shellWords, slash, splitBranch } from './split-worktree.mjs';
import { inScratchZone } from './scratch-zone.mjs';

export const SHELL = /^(Bash|PowerShell)$/;

const SCRIPT = /^(?:dev|develop|build|start|preview|serve|storybook|watch)(?:[:._-].*)?$|shot/i;
const TOOL_BIN =
  /^(?:vite|next|nuxt|nuxi|astro|webpack|webpack-dev-server|webpack-cli|rsbuild|rspack|parcel|storybook|start-storybook|playwright|react-scripts|ng|remix|svelte-kit)$/i;
const SHOT_FILE = /shot/i;
const RUNNERS = new Set(['npm', 'pnpm', 'yarn', 'bun', 'npx', 'pnpx', 'bunx']);
// Runner options whose next word is a value, not the script.
const VALUE_OPTS =
  /^(?:--prefix|-C|--dir|--cwd|--filter|-F|--workspace|--registry|--loglevel|--reporter|-p|--package)$/;
const DIR_OPTS = /^(?:--prefix|-C|--dir|--cwd)$/;
const DIR_EQ = /^(?:--prefix|--dir|--cwd)=(.+)$/;
const WRAPPERS = new Set([
  'env',
  'nohup',
  'exec',
  'command',
  'time',
  'cross-env',
  'start-server-and-test',
]);
const CD = new Set(['cd', 'pushd', 'set-location', 'push-location', 'sl', 'chdir']);
const EXEC_SUBS = new Set(['exec', 'x', 'dlx']);

const literal = (w) => Boolean(w) && !/[$`%]/.test(w);
const norm = (p) => {
  const n = path.resolve(slash(p));
  return process.platform === 'win32' ? n.toLowerCase() : n;
};
const realOf = (p) => {
  let d = path.resolve(slash(p));
  for (let i = 0; i < 64; i++) {
    try {
      return norm(realpathSync.native(d)) + norm(p).slice(norm(d).length);
    } catch {
      const up = path.dirname(d);
      if (up === d) return null;
      d = up;
    }
  }
  return null;
};
const spellings = (p) => [...new Set([norm(p), realOf(p)].filter(Boolean))];
const inside = (child, parent) => {
  const rel = path.relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
};
const within = (d, root) => spellings(d).some((a) => spellings(root).some((b) => inside(a, b)));
const resolveAt = (base, w) => slash(path.resolve(slash(base), slash(w)));

/** Simple commands of a shell line, split outside quotes on ; && || | & newline and parentheses. */
function simpleCommands(text) {
  const out = [];
  let cur = '';
  let quote = null;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quote) {
      cur += ch;
      if (ch === quote) quote = null;
      else if (ch === '\\' && quote === '"') cur += text[++i] ?? '';
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      cur += ch;
    } else if (ch === '\\' && text[i + 1] !== '\n') {
      cur += ch + (text[++i] ?? '');
    } else if (
      ch === ';' ||
      ch === '\n' ||
      ch === '|' ||
      ch === '(' ||
      ch === ')' ||
      (ch === '&' && !/[<>]/.test(text[i - 1] ?? '') && text[i + 1] !== '>')
    ) {
      if (cur.trim()) out.push(cur.trim());
      cur = '';
    } else cur += ch;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

/** Words without leading assignments and wrappers (`FOO=1 nohup timeout 600 npm …`). */
function stripWrappers(words) {
  let i = 0;
  while (i < words.length) {
    const w = words[i];
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(w)) i++;
    else if (WRAPPERS.has(w.toLowerCase())) i++;
    else if (w === 'timeout' && /^\d/.test(words[i + 1] ?? '')) i += 2;
    else break;
  }
  return words.slice(i);
}

/** The runner's dir option `to` read from `dir`; an absolute one stands even when `dir` is unknown. */
function dirOption(dir, to) {
  if (!literal(to)) return null;
  if (dir) return resolveAt(dir, to);
  return path.isAbsolute(slash(to)) ? slash(to) : null;
}

/**
 * What one simple command starts and from where: `{what, at}` — `at` the judged directory or file
 * (relative to `cwd`), null when the command is none of the judged kinds or its dir is unresolvable.
 */
function judged(words, cwd) {
  const w = stripWrappers(words);
  if (!w.length) return null;
  const bin = path
    .basename(slash(w[0]))
    .replace(/\.(?:cmd|exe|ps1)$/i, '')
    .toLowerCase();
  if (bin === 'node' || (bin === 'bun' && w[1] && /\.[cm]?[jt]s$/.test(w[1]))) {
    const file = w.slice(1).find((a) => !a.startsWith('-'));
    if (!file || !literal(file)) return null;
    const isTool =
      /node_modules[\\/](?:\.bin[\\/])?(?:vite|next|webpack|playwright|storybook|astro|nuxt)/i.test(
        file,
      );
    if (!isTool && !SHOT_FILE.test(path.basename(slash(file)))) return null;
    return cwd ? { what: `node ${file}`, at: resolveAt(cwd, file) } : null;
  }
  if (TOOL_BIN.test(bin)) return cwd ? { what: w.join(' ').slice(0, 120), at: cwd } : null;
  if (!RUNNERS.has(bin)) return null;
  let dir = cwd;
  const positional = [];
  for (let k = 1; k < w.length; k++) {
    const a = w[k];
    if (a === '--') break;
    const eq = DIR_EQ.exec(a);
    if (eq || DIR_OPTS.test(a)) {
      const to = eq ? eq[1] : w[++k];
      dir = dirOption(dir, to);
    } else if (VALUE_OPTS.test(a) || (bin === 'npm' && a === '-w')) k++;
    else if (!a.startsWith('-')) positional.push(a);
  }
  if (!dir) return null;
  const exec = bin === 'npx' || bin === 'pnpx' || bin === 'bunx';
  let target = null;
  if (exec) target = positional[0];
  else if (EXEC_SUBS.has(positional[0])) target = positional[1];
  if (target !== null) {
    const name = path.basename(slash(target ?? '')).replace(/@.*$/, '');
    return TOOL_BIN.test(name) ? { what: w.join(' ').slice(0, 120), at: dir } : null;
  }
  const script =
    positional[0] === 'run' || positional[0] === 'run-script' ? positional[1] : positional[0];
  if (bin === 'npm' && !['run', 'run-script', 'start', 'restart'].includes(positional[0]))
    return null;
  return script && SCRIPT.test(script) ? { what: w.join(' ').slice(0, 120), at: dir } : null;
}

/** The first judged command of the line that runs in a foreign tree: `{what, tree}`, else null. */
export function foreignRun(command, input, copy) {
  let cwd = slash(input?.cwd || process.cwd());
  for (const part of simpleCommands(String(command ?? ''))) {
    const words = shellWords(part);
    if (!words.length) continue;
    const head = words[0].toLowerCase();
    if (CD.has(head)) {
      const to = words.slice(1).find((a) => !/^-/.test(a));
      cwd = cwd && literal(to) ? resolveAt(cwd, to) : null;
      continue;
    }
    const hit = judged(words, cwd);
    if (!hit) continue;
    if (within(hit.at, copy)) continue;
    if (inScratchZone(hit.at, input)) continue;
    const tree = repoAt(hit.at);
    if (!tree) continue;
    return { what: hit.what, tree: tree.root };
  }
  return null;
}

export default function ownCopyGuard(input) {
  if (process.env.AGENTDECK_SPLIT_CHILD !== '1') return null;
  if (!SHELL.test(String(input?.tool_name ?? ''))) return null;
  const at = input?.cwd || process.cwd();
  const copy = (splitBranch(at) ?? repoAt(at))?.root;
  if (!copy) return null;
  let hit;
  try {
    // PowerShell has no backslash escape: `C:\work\x` is a path there, not `C:workx`.
    const raw = String(input?.tool_input?.command ?? '');
    const command = input.tool_name === 'PowerShell' ? raw.replace(/\\/g, '/') : raw;
    hit = foreignRun(command, input, copy);
  } catch {
    return null;
  }
  if (!hit) return null;
  return deny(
    `own-copy-guard A group runs dev servers, builds and shots only from its own copy ${copy}. ` +
      `\`${hit.what}\` runs in ${hit.tree}, a tree that is not yours (the user's main checkout or ` +
      "another group's worktree): its sources and built packages are not the pre-change state of " +
      'your branch, and its caches land in a tree you do not own. Run it from your copy. BEFORE ' +
      'shots after the first edit already landed: unpack the base commit inside your copy — ' +
      '`mkdir -p .agent/tmp/base && git archive $(git merge-base HEAD origin/<target branch>) | tar -x -C .agent/tmp/base` ' +
      '— install and build its local packages there, and run its dev server on another port.',
  );
}
