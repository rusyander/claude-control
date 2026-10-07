// Destructive-op guard (PreToolUse on Bash/PowerShell): file deletes (shell and inline code),
// working-copy discards, DROP/TRUNCATE, kubectl delete, docker volume wipes. Silent on everything else.
//
// Verdict is `deny`, never `ask` — see `consent.mjs` for why and for the doors that open it.
// Ops that destroy state other people share (SQL DDL, a cluster, a release) set `reconfirm`: the
// user's standing "clean up" is not enough, they answer for that specific command. Local file
// deletes ride in on door A, because "delete dist" is an instruction, not a hint.
// Reasons are English: a deny reason is read by the model, not by the user.
//
// Deletes: deleting REAL files always asks — recursive or not, `-f` or not;
// only agent litter goes unasked: the system temp dir, the session scratchpad, a repo's `.agent/`,
// the kit's own state dir (`agentdeck-kit-state`) — and regenerable tool caches (`node_modules`, `.vite`, `.vitest`, `.gradle`,
// `__pycache__`, a `coverage` dir holding coverage output). Until then a plain `rm file` passed while `rm -f file` was refused, and a
// `cd "$TEMP" && rm -r …` was refused because the temp test looked for a literal path. Now every
// target is resolved on its own — variables assigned in the command, `for` lists, the last `cd`,
// the session cwd — and the delete passes only when ALL of them land in an agent zone.
//
// The split group's own worktree: a group works in `<repo>-worktrees/<dir>` on a branch named after
// its tracker key (`split-worktree.mjs`), and routine recovery there kept
// stopping on a card — `git checkout HEAD -- <file>` mid-rebase, deleting a probe it had written
// itself. Two narrow passes, both only inside that worktree: a discard of NAMED FILES (no `.`, no
// directory, no glob, no `-f`, no switch), and a delete of files THIS session created (Write tool or a
// shell redirect in the transcript) that git does not track. A tracked file, a directory, a file the
// session never wrote, the main clone, a branch with no tracker key — the ordinary doors.
import { consentGate, ASK_THE_USER } from './consent.mjs';
import { commandText, executedText } from './shell-text.mjs';
import { readTail, sinceLastCompact } from './transcript.mjs';
import { shellWords, gitCall, ownSplitAt, slash } from './split-worktree.mjs';
import path from 'node:path';
import { readdirSync, statSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { homedir } from 'node:os';

// A resolved target path inside one of these is agent litter.
const AGENT_ZONE =
  /(?:scratchpad|AppData[\\/]Local[\\/]Temp(?:[\\/]|$)|^\/tmp(?:\/|$)|[\\/]tmp[\\/]|^\$\{?(?:TEMP|TMP|TMPDIR)\b|^\$\{?LOCALAPPDATA\}?[\\/]Temp(?:[\\/]|$)|^%(?:TEMP|TMP)%|^\$env:(?:TEMP|TMP)\b|tmpdir\(\)|gettempdir\(\)|mkdtemp|mktemp|(?:^|[\\/])\.agent(?:[\\/]|$)|agentdeck-kit-state(?:[\\/]|$))/i;
// Inline code and Remove-Item are judged on the whole command: their targets are expressions.
const TEMP_TEXT =
  /(scratchpad|AppData[\\/]Local[\\/]Temp|[\\/]tmp[\\/]|\$\{?(?:TEMP|TMP|TMPDIR)\b|\$\{?LOCALAPPDATA\}?[\\/]Temp|%(?:TEMP|TMP)%|\$env:(?:TEMP|TMP)\b|process\.env\.(?:TEMP|TMP|TMPDIR)\b|tmpdir\(\)|gettempdir\(\)|tempfile\.|mkdtemp|[\\/]\.agent[\\/]tmp[\\/])/i;

const DELETE_INTENT =
  /(?<![а-яё])(?:удал(?!ённ|енн)|снес|снос|сотр|почист|подчист|вычист|убер|прибей|прун)[а-яё]*|\b(?:rm|delete|remove|clean|wipe|nuke|prune|purge)\b/i;
// Discarding the working copy. Narrower than DELETE_INTENT on purpose: "clean up the code" is a refactor,
// never a licence to throw uncommitted edits away. "cancel" stays out — it is also how the user says
// "stop what you are doing", and that must not open a discard.
const DISCARD_INTENT =
  /(?<![а-яё])(?:откат|сброс|сбрось|выкин|верни|вернуть|удали\s+(?:изменени|правк))[а-яё]*|\b(?:discard|revert|restore|reset|undo)\b/i;
// Inline code is a shell by another name: `Bash(node -e *)` / `python -c` are allow-listed, so a
// delete written as a one-liner would skip every text rule above. Flags may sit in between
// (`node --input-type=module -e`), and a here-doc feeds code the same way.
const INLINE_CODE =
  /\b(?:node|bun|deno)\b[^\n;&|]*?\s(?:-e|--eval|-p|--print)\b|\b(?:node|bun|deno|python[\d.]*|py)\b[^\n;&|]*?<<|\bpython[\d.]*\b[^\n;&|]*?\s-c\b/i;

// `rm`, `unlink`, `git rm` in COMMAND position — so not `docker rm` (a container), not `--rm`, not a
// variable called `rm` inside `node -e` code.
const RM =
  /(?<=(?:^|[;&|(){}\n`"']|\b(?:then|do|else|sudo|xargs|exec|time|nohup|command|-exec|-execdir))\s*)(?:git\s+(?:-C\s+\S+\s+)?)?(?:rm|unlink)(?=\s)/g;
const FIND_DELETE = /(?<![\w./-])find(?=\s)(?=[^\n;&|]*\s-delete\b)/g;
const REMOVE_ITEM = String.raw`(?:Remove-Item|ri|rd|del|erase|rmdir(?=[^\n;&|]*\s(?:\/s|-r)))`;

// `git` and its global options up to the subcommand: `git -C web clean -fd`, `git -c k=v restore .`
// walked past `\bgit\s+restore` until 25.09.2026 (T5, the same gap as `git -C . push`).
const GIT = String.raw`\bgit\s+(?:(?:-C|-c|--git-dir|--work-tree|--namespace)\s+[^\s;&|]+\s+|--?[A-Za-z][\w-]*(?:=[^\s;&|]+)?\s+)*`;

// Reconfirm ops have no door-A intent; `asked` is what my question must name for doors B′/D.
const RULES = [
  {
    id: 'rm',
    find: RM,
    targets: rmTargets,
    unless: /^git\b[^\n;&|]*\s--cached\b/, // untracks, the file stays on disk
    why: 'deletes files outside the agent zones',
    intent: DELETE_INTENT,
  },
  {
    id: 'rm',
    find: FIND_DELETE,
    targets: findTargets,
    why: 'find -delete removes every file it matches',
    intent: DELETE_INTENT,
  },
  {
    // PowerShell Remove-Item and its aliases (ri/rd/del/erase/rmdir), cmd rd/del/erase/`rmdir /s`, in
    // COMMAND position only: a bare `\bri\b` fired on `grep -ri` and `ls -rd`, while `cmd /c del`,
    // `… | ri` and a PowerShell `del` passed. Bash `rmdir` without a recursive flag only drops an
    // empty directory. Right after a quote it needs arguments: `'del'` in code is a literal.
    id: 'remove-item',
    re: new RegExp(
      String.raw`(?<=(?:^|[;&|(){}\n])\s*|(?:\s\/[ck]|\s-c(?:ommand)?|\b(?:then|do|else|sudo|xargs|exec|time|nohup|command))\s+)${REMOVE_ITEM}(?=[\s;&|"'\x60]|$)|(?<=["'\x60]\s*)${REMOVE_ITEM}(?=\s)`,
      'i',
    ),
    why: 'Remove-Item / del / rd deletes files',
    intent: DELETE_INTENT,
    tempText: true,
  },
  {
    id: 'git-clean',
    re: new RegExp(String.raw`${GIT}clean\b[^\n]*-[a-z]*f`, 'i'),
    why: 'git clean -f wipes untracked files, including ones never committed anywhere',
    intent: DELETE_INTENT,
  },
  {
    // Uncommitted edits exist nowhere else — CLAUDE.md leaves them for the user to commit, so a
    // discard is the one git op with no undo. `reset --hard` / `stash drop` sit in git-guard; these
    // are the forms it never saw: a pathspec after `--`, `.`/`./x`, `-f`, and `restore` unless it
    // only unstages (`--staged` without `--worktree`).
    id: 'git-discard',
    re: new RegExp(
      String.raw`${GIT}(checkout\b[^\n|;&]*(\s--(\s|$)|\s(-f|--force)\b|\s\.(?=[\s\\/]|$))|switch\b[^\n|;&]*\s(-f|--force|--discard-changes)\b|restore\b)`,
      'i',
    ),
    unlessCmd: new RegExp(
      String.raw`${GIT}restore\b(?=[^\n|;&]*\s(--staged|-S)\b)(?![^\n|;&]*\s(--worktree|-W)\b)`,
      'i',
    ),
    why: 'discards uncommitted working-copy changes — they exist nowhere else and cannot be recovered',
    intent: DISCARD_INTENT,
  },
  {
    id: 'inline-rm',
    when: INLINE_CODE,
    re: /\b(rmSync|rmdirSync|unlinkSync|fs\.rm|fs\.unlink|fs\.promises\.(?:rm|unlink))\s*\(|\bshutil\.rmtree\s*\(|\bos\.(?:remove|unlink|rmdir)\s*\(|\.unlink\s*\(|\bRemove-Item\b/i,
    why: 'file delete inside inline code (node -e / python -c) — same effect as rm',
    intent: DELETE_INTENT,
    tempText: true,
  },
  {
    id: 'sql-ddl',
    re: /\b(DROP\s+(TABLE|DATABASE|SCHEMA|INDEX)|TRUNCATE\s+TABLE|TRUNCATE\s+\w+)/i,
    why: 'destructive SQL (DROP/TRUNCATE) — the kit safety rule allows SELECT/EXPLAIN/schema only',
    reconfirm: true,
    asked: /\b(?:DROP|TRUNCATE)\b|(?<![а-яё])(?:дроп|удал(?!ённ|енн)|очист|снес)[а-яё]*/i,
  },
  {
    id: 'sql-delete',
    re: /\bDELETE\s+FROM\b(?![^;]*\bWHERE\b)/i,
    why: 'DELETE without WHERE empties the table',
    reconfirm: true,
    asked: /\bDELETE\b|(?<![а-яё])(?:удал(?!ённ|енн)|очист)[а-яё]*/i,
  },
  {
    id: 'kubectl-delete',
    re: /\bkubectl\s+delete\b/i,
    why: 'kubectl delete',
    reconfirm: true,
    asked: /kubectl\s+delete|\bdelete\b|(?<![а-яё])удал(?!ённ|енн)[а-яё]*/i,
  },
  {
    id: 'helm-uninstall',
    re: /\bhelm\s+(uninstall|delete)\b/i,
    why: 'helm uninstall',
    reconfirm: true,
    asked:
      /\bhelm\s+(?:uninstall|delete)\b|\buninstall\b|(?<![а-яё])(?:удал(?!ённ|енн)|снес)[а-яё]*/i,
  },
  {
    id: 'docker-prune',
    re: /\bdocker\s+(volume\s+rm|volume\s+prune|system\s+prune)\b/i,
    why: 'removes docker volumes/caches',
    intent: DELETE_INTENT,
  },
  {
    id: 'compose-down-v',
    re: /\bdocker[\s-]compose\s+down\b[^\n]*(-v|--volumes)/i,
    why: 'compose down with volume removal — the database volume goes with it',
    intent: DELETE_INTENT,
  },
];

export default function destructiveGuard(input) {
  const raw = input?.tool_input?.command;
  // Only what executes is judged — a here-doc written to a file, a quoted string no shell or SQL
  // client runs (a commit message, an `echo`, a `sed` expression) is text. See `shell-text.mjs`.
  const command = executedText(raw);
  if (!command) return null;
  const original = commandText(raw); // same length — indexes carry over
  for (const rule of RULES) {
    const {
      id,
      re,
      find,
      targets,
      when,
      unless,
      unlessCmd,
      why,
      intent,
      asked,
      reconfirm,
      tempText,
    } = rule;
    if (when && !when.test(command)) continue;
    if (unlessCmd?.test(command)) continue;
    if (find) {
      const hit = [...command.matchAll(find)].find((m) => {
        const rest = simpleCommand(command, m.index);
        if (unless?.test(original.slice(m.index, m.index + rest.length))) return false;
        return !targets(original, m, rest.length, input).every(
          (t) => inAgentZone(t) || ownScratch(t, input),
        );
      });
      if (!hit) continue;
    } else {
      if (!re.test(command)) continue;
      if (tempText && TEMP_TEXT.test(original)) continue;
      if (id === 'git-discard' && ownWorktreeDiscard(command, original, re, input)) continue;
    }
    return consentGate(input, {
      marker: `destructive-guard(${id})`,
      intent,
      asked,
      reconfirm,
      reason: `${why}. The user has not authorised it in this turn. ${ASK_THE_USER}${id === 'rm' ? ' Probes and scratch files belong in the session scratchpad or <repo>/.agent/tmp/ — deletes there need no answer.' : ''}`,
    });
  }
  return null;
}

// --- Target resolution ----------------------------------------------------------------------------

/** The simple command starting at `at` (up to the next separator), from the executed text. */
function simpleCommand(text, at) {
  return text.slice(at).match(/^[^\n;&|)]*/)[0];
}

const ASSIGN =
  /(?:^|[\s;&|(])(?:export\s+|local\s+|declare\s+)?([A-Za-z_]\w*)=((?:"(?:[^"\\]|\\.)*"|'[^']*'|\$\((?:[^()]|\((?:[^()]|\([^()]*\))*\))*\)|[^\s;&|()"'])+)/g;
const FOR_LIST = /\bfor\s+([A-Za-z_]\w*)\s+in\s+([^;\n]*)/g;
const CD = /(?:^|[\s;&|(])(?:cd|pushd)\s+((?:"(?:[^"\\]|\\.)*"|'[^']*'|[^\s;&|()"'])+)/g;
const TEMP_VAR = /^(?:TEMP|TMP|TMPDIR)$/;
const PWD = /\$\(pwd\)|\$\{?PWD\}?(?!\w)/g;

/** Variables the command itself defines before `at`: name → possible values. */
function variables(text, at) {
  const vars = new Map();
  const before = text.slice(0, at);
  for (const m of before.matchAll(ASSIGN)) {
    if (TEMP_VAR.test(m[1])) continue;
    vars.set(m[1], [m[2].startsWith('$(') ? m[2] : shellWords(m[2]).join(' ')]);
  }
  for (const m of before.matchAll(FOR_LIST)) vars.set(m[1], shellWords(m[2]));
  return vars;
}

/** Every concrete value a word can take; an unknown variable stays as `$NAME`. */
function expand(word, vars, depth = 0) {
  const m = word.match(/\$\{?([A-Za-z_]\w*)\}?/);
  if (!m || depth > 4 || TEMP_VAR.test(m[1]) || !vars.has(m[1])) return [word];
  return vars
    .get(m[1])
    .flatMap((v) =>
      expand(word.slice(0, m.index) + v + word.slice(m.index + m[0].length), vars, depth + 1),
    );
}

const ANCHORED =
  /^(?:[\\/~]|[A-Za-z]:|\$\{?(?:TEMP|TMP|TMPDIR|HOME|USERPROFILE|LOCALAPPDATA)\b|%|\$env:)/i;

/** Absolute-ish form of a target: relative ones hang off the last `cd`, else the session cwd. */
function place(target, base) {
  const t = target.replace(/\\/g, '/');
  const full = ANCHORED.test(t) || !base ? t : `${base.replace(/\\/g, '/')}/${t}`;
  return path.posix.normalize(full);
}

function baseDir(text, at, vars, input) {
  let base = String(input?.cwd ?? '');
  const closed = closedSubshells(text.slice(0, at));
  for (const m of text.slice(0, at).matchAll(CD)) {
    // CD's prefix group may consume the `(` itself, hence >=.
    if (closed.some(([a, b]) => m.index >= a && m.index < b)) continue;
    const dir = expand(shellWords(m[1]).join(' '), vars)[0].replace(PWD, base);
    base = ANCHORED.test(dir.replace(/\\/g, '/')) ? dir : place(dir, base);
  }
  return base;
}

/** `( … )` / `$( … )` spans that close before the delete: a `cd` inside one never reaches it. */
function closedSubshells(text) {
  const open = [];
  const spans = [];
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '(') open.push(i);
    else if (text[i] === ')' && open.length) spans.push([open.pop(), i]);
  }
  return spans;
}

function resolveTargets(text, at, words, input) {
  const vars = variables(text, at);
  const base = baseDir(text, at, vars, input);
  return words.flatMap((w) => expand(w, vars)).map((t) => place(t.replace(PWD, base), base));
}

/** An rm call's words minus redirections (`2>/dev/null`, `> log`, `2>&1`) — never delete targets. */
function operands(words) {
  const out = [];
  for (let i = 0; i < words.length; i++) {
    const redirect = words[i].match(/^(?:\d*|&)(?:>>?|<)(.*)$/);
    if (!redirect) out.push(words[i]);
    else if (!redirect[1]) i++; // `2> file`: the next word belongs to the redirect
  }
  return out;
}

function rmTargets(original, m, len, input) {
  const words = shellWords(original.slice(m.index + m[0].length, m.index + len));
  const targets = operands(words).filter((w) => w && !w.startsWith('-'));
  return targets.length ? resolveTargets(original, m.index, targets, input) : [''];
}

function findTargets(original, m, len, input) {
  const first = shellWords(original.slice(m.index + m[0].length, m.index + len))[0];
  return resolveTargets(original, m.index, [first && !first.startsWith('-') ? first : '.'], input);
}

const UNKNOWN_VAR =
  /\$(?!\{?(?:TEMP|TMP|TMPDIR|HOME|USERPROFILE|LOCALAPPDATA)\b|env:(?:TEMP|TMP|USERPROFILE)\b)|`/;

// Regenerable tool caches. `coverage` is also a plausible SOURCE folder name, so it
// passes only when it holds coverage output (a missing dir throws → asks).
const CACHE_DIR = /(?:^|[\\/])(?:node_modules|\.vitest|\.vite|\.gradle|__pycache__)(?:[\\/]|$)/;
const COVERAGE_DIR = /^(.*?(?:^|[\\/])coverage)(?:[\\/]|$)/;
const COVERAGE_OUTPUT =
  /^(?:lcov\.info|lcov-report|coverage-final\.json|coverage-summary\.json|clover\.xml|cobertura-coverage\.xml|\.tmp)$/;
const nativePath = (p) => p.replace(/^~(?=[\\/]|$)/, homedir()).replace(/^\/([a-z])(?=\/)/i, '$1:');

function regenerable(target) {
  if (CACHE_DIR.test(target)) return true;
  const m = target.match(COVERAGE_DIR);
  if (!m) return false;
  try {
    return readdirSync(nativePath(m[1])).some((n) => COVERAGE_OUTPUT.test(n));
  } catch {
    return false;
  }
}

/** An unknown variable or command substitution could be anything — never a zone by default. */
function inAgentZone(target) {
  if (!target) return false;
  // A substitution that makes a temp dir IS the zone; any other one is unknown.
  const t = target.replace(/\$\((?:[^()]|\((?:[^()]|\([^()]*\))*\))*\)/g, (s) =>
    /mktemp|tmpdir\(\)|gettempdir/.test(s) ? 'mktemp' : '$UNKNOWN',
  );
  return !UNKNOWN_VAR.test(t) && (AGENT_ZONE.test(t) || regenerable(t));
}

// --- The split group's own worktree -----------------------------------------------------------------

/** Pathspecs that name the whole tree, a pattern, or git pathspec magic — never "one file". */
const WIDE_PATHSPEC = /^(?:\.{1,2}\/?|:.*)$|[*?[]/;
const RESTORE_VALUE_OPTS = /^(?:-s|--source)$/;

/** A pathspec naming one file inside the worktree: not wide, not a directory, not outside the root. */
function namesOneFile(spec, dir, root) {
  if (!spec || WIDE_PATHSPEC.test(spec)) return false;
  const abs = path.resolve(dir, slash(spec));
  const rel = path.relative(path.resolve(root), abs);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return false;
  try {
    return !statSync(abs).isDirectory();
  } catch {
    return true; // deleted on the branch or only on the other side of a conflict: still one file
  }
}

/** A file-level `checkout <tree-ish> -- <files>` / `restore <files>` inside the own split worktree. */
function fileDiscardInOwnWorktree(call, input) {
  const own = call?.dir && ownSplitAt(call.dir, input?.cwd);
  if (!own) return false;
  const { sub, args } = call;
  if (
    args.some((a) =>
      /^(?:-f|--force|-p|--patch|--pathspec-from-file(?:=.*)?|--discard-changes)$/.test(a),
    )
  )
    return false;
  let paths;
  if (sub === 'checkout') {
    const sep = args.indexOf('--');
    // Without `--` a word may be a branch or a file — `git checkout x` stays with the ordinary doors.
    if (sep < 0) return false;
    const before = args.slice(0, sep).filter((a) => !/^--(?:ours|theirs)$|^-q$|^--quiet$/.test(a));
    if (before.length > 1 || before.some((a) => a.startsWith('-'))) return false;
    paths = args.slice(sep + 1);
  } else if (sub === 'restore') {
    paths = [];
    for (let i = 0; i < args.length; i++) {
      const a = args[i];
      if (RESTORE_VALUE_OPTS.test(a)) i++;
      else if (a === '--' || a.startsWith('-')) continue;
      else paths.push(a);
    }
  } else return false;
  return paths.length > 0 && paths.every((p) => namesOneFile(p, call.dir, own.root));
}

/** Every discard in the command is a file-level one inside the own split worktree. */
function ownWorktreeDiscard(command, original, re, input) {
  try {
    const calls = [...command.matchAll(/\bgit\s/g)]
      .map((m) => ({ m, simple: command.slice(m.index).match(/^[^\n|;&)]*/)[0] }))
      .filter(({ simple }) => new RegExp(re.source, re.flags.replace('g', '')).test(simple));
    return (
      calls.length > 0 &&
      calls.every(({ m }) =>
        fileDiscardInOwnWorktree(gitCall(original, m.index, input?.cwd), input),
      )
    );
  } catch {
    return false;
  }
}

const WRITE_TOOLS = /^(?:Write|NotebookEdit)$/;
const SHELL_TOOLS = /^(?:Bash|PowerShell)$/;
// `> file`, `>> file`, `| tee [-a] file` — a file the shell created. `2>&1` is not a target.
const REDIRECT =
  /(?:^|[^<>&\d])>>?\s*("[^"]*"|'[^']*'|[^\s;&|<>()]+)|\btee\s+(?:-a\s+)?("[^"]*"|'[^']*'|[^\s;&|<>()]+)/g;
const made = new WeakMap();
const same = (p) => {
  const n = path.resolve(slash(p));
  return process.platform === 'win32' ? n.toLowerCase() : n;
};

/** Absolute paths this session created, from the transcript (cached per hook call). */
function madeThisSession(input) {
  if (made.has(input)) return made.get(input);
  const out = new Set();
  const cwd = slash(input?.cwd || process.cwd());
  for (const r of sinceLastCompact(readTail(input?.transcript_path))) {
    const content = r?.type === 'assistant' ? r.message?.content : null;
    if (!Array.isArray(content)) continue;
    for (const c of content) {
      if (c?.type !== 'tool_use') continue;
      if (WRITE_TOOLS.test(c.name) && typeof c.input?.file_path === 'string')
        out.add(same(path.resolve(cwd, slash(c.input.file_path))));
      if (SHELL_TOOLS.test(c.name) && typeof c.input?.command === 'string') {
        for (const m of c.input.command.matchAll(REDIRECT)) {
          const w = shellWords(m[1] ?? m[2])[0];
          if (w && !/[$`]/.test(w)) out.add(same(path.resolve(cwd, slash(w))));
        }
      }
    }
  }
  made.set(input, out);
  return out;
}

/** An untracked file THIS session created inside the own split worktree. */
function ownScratch(target, input) {
  try {
    if (!target || /[$`]/.test(target)) return false;
    const abs = path.resolve(slash(target));
    const own = ownSplitAt(path.dirname(abs), input?.cwd);
    if (!own) return false;
    const rel = path.relative(path.resolve(own.root), abs);
    if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return false;
    if (!statSync(abs).isFile()) return false;
    if (!madeThisSession(input).has(same(abs))) return false;
    // 1 = not in the index; 0 = tracked; anything else (no git, timeout) = cannot tell, so ask.
    const r = spawnSync('git', ['-C', own.root, 'ls-files', '--error-unmatch', '--', slash(rel)], {
      encoding: 'utf8',
      timeout: 5000,
      windowsHide: true,
    });
    return r.status === 1;
  } catch {
    return false;
  }
}
