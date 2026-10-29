// PreToolUse(Read|Grep|Glob): a long read-only sweep belongs in a subagent, not in the main window.
//
// Measured over 30 days: Read results alone are 4.4M tokens of context, Grep+Glob another 0.4M.
// Reconnaissance content stays in the window for the rest of the session and is re-billed on every
// later request, while its *conclusion* is usually a few lines. A subagent reads the same files in
// its own window and returns only the answer.
//
// Fires at most ONCE per turn, and only for a pure sweep: many read-only calls, zero edits, no
// subagent used yet. Any of those conditions failing means this is ordinary work, not recon.
//
// And only when the user allowed subagents in THIS turn's prompt: orchestration is opt-in (global
// CLAUDE.md), so without a grant "delegate" is advice the model may not follow. Ungated, 16–23.09.2026:
// 43 refusals, 39 in turns that went on to edit, 18 escaped by repeat, 1 delegation — the turn whose
// prompt had granted agents.
//
// Bash branch: `grep -r` rooted at a tree that holds node_modules walks every dependency file BEFORE any
// `| grep -v node_modules` (that filters the output, not the walk) — over a minute in one group run where
// the Grep tool (ripgrep, honours .gitignore) or `git grep` takes seconds. Fires in subagents too: the walk
// is slow in any window. Also refused: an unscoped `grep -r` over a whole repository outside the session's
// own copy (F10: the panel repo walked from a group's copy, 2-min timeout). The identical command repeated
// after the refusal goes through.
import { existsSync, readdirSync, statSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import {
  readTail,
  sinceLastCompact,
  toolEvents,
  resultFor,
  wasJustRefused,
  deny,
  wasBlocked,
  isSyntheticPrompt,
  stripReminders,
  currentUserPrompt,
  inSubagent,
  ownTranscript,
} from './transcript.mjs';

const SWEEP_LIMIT = 12; // read-only calls in one turn before delegation is cheaper
const RECON = new Set(['Read', 'Grep', 'Glob']);
const EDITS = new Set(['Edit', 'Write', 'NotebookEdit', 'MultiEdit']);
// Delegation already happened (or is being driven) — say nothing.
const DELEGATES = new Set(['Agent', 'Task', 'SendMessage', 'Workflow']);

// Our own marker, so a second sweep call in the same turn stays silent instead of nagging.
const MARK = 'search-discipline';

// The user can opt out of delegation for this turn, either by asking for the sweep explicitly
// or by saying they want it done inline.
const USER_OVERRIDE =
  /без\s+субагент|не\s+используй\s+субагент|сам\s+посмотри|сам\s+прочитай|вручную|no\s+subagents?\b|don'?t\s+delegate/i;

// The user handing work to agents this turn. Cyrillic needs explicit bounds (\b is ASCII-only), and
// `.agent/` paths in a prompt are not a grant.
const DELEGATION_GRANTED =
  /(?<![а-яё])(?:суб|саб)?агент(?:а|ы|ов|ам|ами|ах|у)?(?![а-яё])|параллельн|делегир|(?<![\w./-])(?:sub-?)?agents?(?![\w/-])|fan[- ]?out|\bworkflow\b|ultracode/i;

export default function searchDiscipline(input) {
  const tool = input?.tool_name;
  if (tool === 'Bash') return slowGrep(input);
  if (!RECON.has(tool)) return null;

  // Inside a subagent the sweep IS the delegated work — never block it there.
  if (inSubagent(input)) return null;

  const records = sinceLastCompact(readTail(input.transcript_path));
  if (records.length === 0) return null;
  const events = toolEvents(records);

  const sameCall = (other) => stableKey(other) === stableKey(input.tool_input);
  if (wasJustRefused(events, tool, sameCall)) return null;

  // Only count the CURRENT turn. When the user's message is not in the parsed tail we cannot tell
  // where the turn began, so we stay silent rather than risk counting several turns as one.
  const turnStart = lastPromptIndex(records);
  if (turnStart < 0) return null;
  const turnEvents = toolEvents(records.slice(turnStart));

  const said = currentUserPrompt(input, records);
  if (USER_OVERRIDE.test(said) || !DELEGATION_GRANTED.test(said)) return null;

  let recon = 0;
  for (const e of turnEvents) {
    if (e.kind !== 'use') continue;
    if (DELEGATES.has(e.name)) return null; // already delegating this turn
    if (EDITS.has(e.name)) return null; // real work in progress, not a sweep
    if (RECON.has(e.name) && !wasRefused(turnEvents, e)) recon++;
  }
  if (recon < SWEEP_LIMIT) return null;
  if (alreadyNagged(turnEvents)) return null;

  return deny(
    `${MARK}: ${recon} read-only calls this turn with no edits — this is reconnaissance, and every ` +
      `file read stays in the window for the rest of the session. The user allowed subagents this ` +
      `turn: hand the rest to one (Explore for "where is X", general-purpose for an audit) — it reads ` +
      `in its own window, writes findings to .agent/tmp/ and returns <=10 lines. Or narrow the sweep: ` +
      `one targeted Grep, then Read with offset/limit. Genuinely need this one call inline — repeat it ` +
      `and it goes through.`,
  );
}

/** The Bash branch: a recursive grep over node_modules is refused once, pointing at the fast tools. */
function slowGrep(input) {
  const command = String(input?.tool_input?.command ?? '');
  if (!/\bgrep\b/.test(command)) return null;
  const cwd = String(input?.cwd || process.cwd());
  const roots = slowGrepRoots(command, cwd);
  const foreign = roots.length ? [] : foreignTreeRoots(command, cwd);
  if (!roots.length && !foreign.length) return null;
  const events = toolEvents(sinceLastCompact(readTail(ownTranscript(input))));
  if (wasJustRefused(events, input.tool_name, (o) => String(o?.command ?? '') === command))
    return null;
  if (!roots.length)
    return deny(
      `${MARK} (grep): \`grep -r\` over ${foreign.join(', ')} walks a whole repository outside this session's ` +
        `copy (${ownTop(cwd).replace(/\\/g, '/')}), unscoped. Scope it: \`git -C <that repo> grep -n <pattern> -- ` +
        `'<dir>/*.ts'\`, the Grep tool with path=<repo>/<package>/src, or \`grep -rn <pattern> ` +
        `--include=<glob> --exclude-dir=node_modules <repo>/<package>/src\`. Genuinely need this exact command — ` +
        `repeat it and it goes through.`,
    );
  return deny(
    `${MARK} (grep): \`grep -r\` over ${roots.join(', ')} walks every node_modules file before any filter ` +
      `(\`| grep -v node_modules\` filters the output and \`--include\` the file names, not the walk) — minutes ` +
      `where ripgrep takes seconds. Use the Grep tool (ripgrep, honours .gitignore) or \`git grep -n <pattern> ` +
      `-- <paths>\` (another repository: \`git -C <repo> grep …\`), or add --exclude-dir=node_modules. Genuinely need this exact command — repeat ` +
      `it and it goes through.`,
  );
}

// Git Bash spells a drive `/c/work/…`; on Windows Node resolves that to `C:\c\work\…`, a path that does not
// exist — g9 26.10: `cd /c/work/agentdeck; grep -rln … .` walked the panel repo's node_modules
// unseen (2-min timeout). On win32 a one-letter first segment is the drive.
const hostPath = (p) =>
  process.platform === 'win32'
    ? String(p).replace(/^\/([a-zA-Z])(?=\/|$)/, (_, d) => `${d.toUpperCase()}:`)
    : String(p);

/** The git top of `cwd` (the session's own copy); `cwd` itself when it is in no repository. */
function ownTop(cwd) {
  let dir = resolve(cwd);
  for (;;) {
    if (existsSync(join(dir, '.git'))) return dir;
    const up = dirname(dir);
    if (up === dir) return resolve(cwd);
    dir = up;
  }
}

const inside = (child, parent) => {
  const rel = relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
};

/** A repository top, or a folder holding repositories one level down (`C:/work`). */
function wholeTree(dir) {
  try {
    if (!statSync(dir).isDirectory()) return false;
    if (existsSync(join(dir, '.git'))) return true;
    let seen = 0;
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (!e.isDirectory() || e.name.startsWith('.')) continue;
      if (++seen > 200) break;
      if (existsSync(join(dir, e.name, '.git'))) return true;
    }
  } catch {
    /* unreadable root: nothing to say */
  }
  return false;
}

/**
 * Roots of every unscoped recursive grep (no --include, no node_modules exclusion) over a whole
 * repository outside the session's own copy (F10, g9 26.10). A package dir (`<repo>/apps/x/src`) is
 * no whole tree.
 */
export function foreignTreeRoots(command, cwd) {
  const own = ownTop(cwd);
  const flagged = [];
  for (const { dir, g } of recursiveGreps(command, cwd)) {
    if (g.excludesNodeModules || g.included) continue;
    for (const root of g.roots.length ? g.roots : ['.']) {
      if (/[*?[]/.test(root)) continue;
      const abs = resolve(dir, hostPath(root) || '.');
      if (!inside(abs, own) && wholeTree(abs)) flagged.push(root);
    }
  }
  return flagged;
}

// grep options whose value is the NEXT token when not glued on (-e PAT, -A 3, --include GLOB).
const SHORT_WITH_ARG = new Set(['e', 'f', 'm', 'A', 'B', 'C', 'd', 'D']);
const LONG_WITH_ARG = new Set([
  'regexp',
  'file',
  'max-count',
  'after-context',
  'before-context',
  'context',
  'directories',
  'devices',
  'exclude',
  'exclude-dir',
  'exclude-from',
  'include',
  'label',
]);

/**
 * Search roots of every recursive grep in `command` that would walk node_modules (at the root or one
 * level down), as written. `cd` before the grep moves the base; a subshell restores it.
 */
export function slowGrepRoots(command, cwd) {
  const flagged = [];
  for (const { dir, g } of recursiveGreps(command, cwd)) {
    if (g.excludesNodeModules) continue;
    for (const root of g.roots.length ? g.roots : ['.']) {
      if (rootWalks(dir, hostPath(root))) flagged.push(root);
    }
  }
  return flagged;
}

/** Every recursive grep of `command` with the folder it runs in (`cd` moves it, a subshell restores it). */
function recursiveGreps(command, cwd) {
  const found = [];
  const stack = [];
  let dir = cwd;
  for (const seg of segments(shellTokens(command))) {
    if (seg.op === '(') {
      stack.push(dir);
      continue;
    }
    if (seg.op === ')') {
      dir = stack.pop() ?? dir;
      continue;
    }
    const words = [...seg.words];
    while (words.length && /^\w+=/.test(words[0])) words.shift(); // VAR=x grep …
    if (words[0] === 'cd') {
      if (words[1] && !words[1].startsWith('-'))
        dir = resolve(
          dir,
          hostPath(
            words[1].replace(/^~(?=$|[\\/])/, process.env.HOME || process.env.USERPROFILE || '~'),
          ),
        );
      continue;
    }
    if (!/^(?:e|f)?grep$/.test(words[0] ?? '')) continue;
    const g = parseGrep(words.slice(1));
    if (g.recursive) found.push({ dir, g });
  }
  return found;
}

/**
 * A glob in the last segment is matched against the real entries: `app/*.json` names files, never a tree
 * (g9 26.10 review: `grep -rn … inst-admin-ui/*.json` was refused as a walk of inst-admin-ui). A glob
 * higher up is cut at the first wildcard — the conservative reading.
 */
function rootWalks(dir, root) {
  const norm = root.replace(/\\/g, '/');
  const cut = norm.search(/[*?[]/);
  if (cut < 0) return walksNodeModules(resolve(dir, norm || '.'));
  if (norm.indexOf('/', cut) >= 0) return walksNodeModules(resolve(dir, norm.slice(0, cut) || '.'));
  const slash = norm.lastIndexOf('/');
  const parent = slash < 0 ? resolve(dir) : resolve(dir, norm.slice(0, slash) || '/');
  const glob = norm.slice(slash + 1);
  const re = new RegExp(
    '^' +
      glob
        .replace(/[.+^${}()|\\]/g, '\\$&')
        .replace(/\*/g, '.*')
        .replace(/\?/g, '.') +
      '$',
  );
  try {
    return readdirSync(parent).some(
      (name) =>
        re.test(name) &&
        (glob.startsWith('.') || !name.startsWith('.')) &&
        (name === 'node_modules' || walksNodeModules(join(parent, name))),
    );
  } catch {
    return false;
  }
}

function parseGrep(args) {
  let recursive = false;
  let excludesNodeModules = false;
  let included = false;
  let patternGiven = false;
  const positional = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--') {
      positional.push(...args.slice(i + 1));
      break;
    }
    if (a.startsWith('--')) {
      const [name, glued] = a.slice(2).split(/=(.*)/s);
      const value = glued ?? (LONG_WITH_ARG.has(name) ? (args[++i] ?? '') : '');
      if (name === 'recursive' || name === 'dereference-recursive') recursive = true;
      if (name === 'directories' && value === 'recurse') recursive = true;
      if (name === 'exclude-dir' && /node_modules/.test(value)) excludesNodeModules = true;
      if (name === 'include') included = true;
      if (name === 'regexp' || name === 'file') patternGiven = true;
      continue;
    }
    if (a.startsWith('-') && a.length > 1) {
      for (let k = 1; k < a.length; k++) {
        const c = a[k];
        if (c === 'r' || c === 'R') recursive = true;
        if (!SHORT_WITH_ARG.has(c)) continue;
        const value = k + 1 < a.length ? a.slice(k + 1) : (args[++i] ?? '');
        if (c === 'e' || c === 'f') patternGiven = true;
        if (c === 'd' && value === 'recurse') recursive = true;
        break;
      }
      continue;
    }
    positional.push(a);
  }
  return {
    recursive,
    excludesNodeModules,
    included,
    roots: patternGiven ? positional : positional.slice(1),
  };
}

/** node_modules directly under `dir` or one level down (a worktree of several apps). */
function walksNodeModules(dir) {
  try {
    if (!statSync(dir).isDirectory()) return false;
    if (existsSync(join(dir, 'node_modules'))) return true;
    let seen = 0;
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (!e.isDirectory() || e.name.startsWith('.')) continue;
      if (++seen > 200) break;
      if (existsSync(join(dir, e.name, 'node_modules'))) return true;
    }
  } catch {
    /* unreadable root: nothing to say */
  }
  return false;
}

/** Shell-ish words with quotes removed; control operators as `{op}` items. Redirections are dropped. */
function shellTokens(cmd) {
  const out = [];
  let cur = '';
  let has = false;
  let quote = null;
  // Only a word whose first char stood outside quotes can be a redirection: `grep -rn "<Button" -A4 dir`
  // lost its quoted pattern as `<…`, the folder became the pattern and the grep read as a walk of `.` (g5 27.10).
  let bare = false;
  const flush = () => {
    const redirection = bare && /^\d*[<>]/.test(cur);
    if (has && !redirection) out.push(cur);
    else if (has && /^\d*[<>]&?$/.test(cur)) out.push({ redirect: true });
    cur = '';
    has = false;
    bare = false;
  };
  for (let i = 0; i < cmd.length; i++) {
    const c = cmd[i];
    if (quote) {
      if (c === quote) quote = null;
      else if (c === '\\' && quote === '"' && '$`"\\\n'.includes(cmd[i + 1] ?? 'x'))
        cur += cmd[++i]; // bash: only these escape inside "…"
      else cur += c;
      continue;
    }
    if (c === "'" || c === '"') {
      quote = c;
      has = true;
      continue;
    }
    if (c === '\\' && i + 1 < cmd.length) {
      cur += cmd[++i];
      has = true;
      continue;
    }
    if (c === '&' && /[<>]$/.test(cur)) {
      cur += c;
      continue;
    } // 2>&1
    if (c === ' ' || c === '\t') {
      flush();
      continue;
    }
    if (';|&()\n'.includes(c)) {
      flush();
      out.push({ op: c });
      continue;
    }
    if (!has) bare = true;
    cur += c;
    has = true;
  }
  flush();
  return out;
}

/** Simple commands between control operators; a redirection marker swallows its target word. */
function segments(tokens) {
  const segs = [];
  let words = [];
  let skip = false;
  const end = () => {
    if (words.length) segs.push({ words });
    words = [];
  };
  for (const t of tokens) {
    if (typeof t === 'string') {
      if (skip) skip = false;
      else words.push(t);
      continue;
    }
    if (t.redirect) {
      skip = true;
      continue;
    }
    end();
    if (t.op === '(' || t.op === ')') segs.push({ op: t.op });
  }
  end();
  return segs;
}

/** Index of the last real user message: not a tool result, not harness text, not a compact summary. */
function lastPromptIndex(records) {
  for (let i = records.length - 1; i >= 0; i--) {
    const r = records[i];
    if (r.type !== 'user' || r.isCompactSummary) continue;
    const c = r.message?.content;
    let text = '';
    if (typeof c === 'string') text = c;
    else if (Array.isArray(c)) {
      // A tool_result also arrives as a "user" record — those must not count as a new turn.
      if (c.some((x) => x && x.type === 'tool_result')) continue;
      text = c
        .filter((x) => x && x.type === 'text' && typeof x.text === 'string')
        .map((x) => x.text)
        .join('\n');
    }
    if (!text.trim()) continue;
    if (isSyntheticPrompt(text)) continue;
    if (!stripReminders(text).trim()) continue; // a pure <system-reminder> record is harness text
    return i;
  }
  return -1;
}

/** A refused call never reached the window, so it must not count towards the sweep. */
function wasRefused(events, use) {
  const res = resultFor(events.slice(events.indexOf(use)), use.id);
  return Boolean(res && wasBlocked(res.body));
}

/** Did we already ask for delegation this turn? One nudge per turn is enough. */
function alreadyNagged(events) {
  // `${MARK}:` — the sweep nudge only; the Bash grep refusal (`${MARK} (grep):`) is a different verdict.
  return events.some(
    (e) => e.kind === 'result' && typeof e.body === 'string' && e.body.includes(`${MARK}:`),
  );
}

/** Identity of a call, used only for the "repeat it and it goes through" escape hatch. */
function stableKey(i) {
  return JSON.stringify([
    i?.file_path ?? '',
    i?.pattern ?? '',
    i?.path ?? '',
    i?.offset ?? 0,
    i?.limit ?? 0,
    i?.glob ?? '',
    i?.output_mode ?? '',
  ]);
}
