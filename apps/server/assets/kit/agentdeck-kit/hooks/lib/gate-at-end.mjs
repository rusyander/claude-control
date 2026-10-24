// PreToolUse(Bash|PowerShell): the FULL gate runs once, at the end of the user's WHOLE task.
//
// Measured: one session ran the full gate (or a whole-project lint) six times in one afternoon —
// 441 s, 410 s, two 600 s foreground kills, a background run sleep-polled, again — about 45 min of
// wall time and window, because every follow-up prompt ended with "gate green". A follow-up
// is part of the same task: it gets narrow checks of the files it touched, and the full gate moves to
// the very end. Quality is unchanged — the full gate still runs on the final tree, just once.
//
// Full gate = a project gate script (`pnpm gate`, `npm run verify`, `make check`) or one command
// batching two or more check kinds (types / lint / tests / deps / build / shots).
//   • allowed: the first full gate of the session; after a RED one once something was edited; when the
//     user's prompt asks for delivery or the gate itself (commit, push, MR, «закрываем», «гейт»).
//   • denied: a full gate after a green one — follow-up work is checked narrowly, the full gate waits
//     for delivery; any full gate with nothing edited since the previous one (read its log).
//   • shape: outside a panel split group it runs with run_in_background and is never piped into
//     tail/head/grep — a foreground gate dies at the 600 s tool cap, a truncated one gets re-run just
//     to read it, and only a background gate can be stopped (TaskStop) when the task grows mid-run.
//     A split group (AGENTDECK_HEAVY_QUEUE_DIR set) is the exception: the panel reads the end of its
//     turn as the group's result, so its gates stay in the foreground.
// Escape: repeat the identical call. Subagents are skipped — the hook sees the parent's transcript.
// State survives compaction in the kit state dir, gates/<session>.json.
// Kit hook item: run by the event dispatcher (lib/run.mjs) or on its own; see lib/items.mjs.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { backgroundParam, stateDir, sessionKey } from './kit-paths.mjs';
import {
  readTail,
  readTailText,
  toolEvents,
  resultFor,
  wasJustRefused,
  deny,
  currentUserPrompt,
  inSubagent,
} from './transcript.mjs';

const KINDS = [
  ['types', /\b(tsc|vue-tsc|svelte-check|type-?check|mypy|pyright)\b/i],
  ['lint', /\b(es-?lint|stylelint|biome|ruff|golangci-lint|lint)\b/i],
  [
    'test',
    /\b(vitest|jest|pytest|mocha|playwright\s+test|go\s+test|cargo\s+test|dotnet\s+test|test)\b/i,
  ],
  ['deps', /\b(depcruise|dependency-cruiser)\b/i],
  ['build', /\b(npm|pnpm|yarn|bun)\s+(run\s+)?build\b|\bgo\s+build\b|\bcargo\s+build\b/i],
  ['shots', /\b(npm|pnpm|yarn|bun)\s+(run\s+)?shots\b/i],
];
// `check-ticket` = a per-ticket gate script (canon + tests + docs, ~8–13 min). Unrecognised, it ran 11×
// per split group — fix → full gate → fix — instead of once per stage; `--dry` only prints a plan.
const GATE_SCRIPT =
  /\b(npm|pnpm|yarn|bun)\s+(run\s+)?(gate|verify|ci|validate|check-all)\b|\bmake\s+(check|ci|verify|gate)\b|\bgate-run(\.mjs)?\b|\bcheck-ticket(\.mjs)?\b(?![^\n;&|]*\s--dry\b)/i;
// `scripts/check_<x>.(mjs|py)` = a project's own gate script (`node scripts/check_all.mjs`,
// `python scripts/check_backend.py`): unrecognised, groups ran it once per stage on the same tree.
// Only the whole-side ones (F-35): `scripts/check_i18n.mjs` is one narrow check the project rules ask
// for, and denying it in a work stage left a group no way to run it; and only as the command itself —
// `eslint scripts/check_all.mjs` lints a file, it runs no gate.
const GATE_SCRIPT_NAMES = /^(?:all|backend|frontend|full|gate|ci|ticket)$/i;
const SCRIPT_RUNNER = /^(?:node|python3?|py|bun|tsx|deno|uv|poetry|pipenv|run)$/i;

/** The segment runs `[runner] [./]…scripts/check_<whole-side>.(mjs|py)` as its own command. */
function projectGateScript(seg) {
  const words = seg
    .replace(/^\s*(?:do|then|else)\s+/, '')
    .trim()
    .split(/\s+/);
  let at = 0;
  while (/^\w+=/.test(words[at] ?? '')) at += 1;
  while (at < words.length && (SCRIPT_RUNNER.test(words[at]) || /^-/.test(words[at]))) at += 1;
  const m = /^(?:\.{0,2}[\\/])?(?:[\w.@-]+[\\/])*scripts[\\/]check_([\w-]+)\.(?:mjs|py)$/i.exec(
    words[at] ?? '',
  );
  return Boolean(m && GATE_SCRIPT_NAMES.test(m[1]));
}
const NOT_CHECK =
  /^\s*(git|grep|rg|cat|ls|dir|echo|type|find|curl|which|where|sed|head|tail|mkdir|rm|cp|mv|touch|ps|kill|taskkill|command|for)\b|\b(install|add|remove|uninstall|upgrade|update|outdated)\b|\s--version\b/i;
const TRUNCATED = /\|\s*(tail|head|grep|rg|findstr|select-string|select-object)\b/i;
// Delivery or an explicit gate request. Bare «готово» stays out: it shows up inside quoted bug
// reports («текст „Готово“…»), and one quote would reopen the full gate for the rest of the turn.
const DELIVERY =
  /(закоммит|коммить|\bcommit\b|запуш|(?<![а-яё])пушь|\bpush\b|merge request|pull request|(открой|создай|оформи|сделай)\s+(mr|мр|pr)(?![a-zа-яё])|закрываем|сдаём|сдаем|финальн\S*\s+(гейт|прогон|проверк)|(?<![а-яё])гейт|\bgate\b|(прогони|запусти|перезапусти|гони)\S*\s+(\S+\s+)?(тест|провер|линт|тайпчек|гейт)|\b(re)?run\s+(the\s+)?(tests|gate|checks|full gate)\b)/i;
const EDIT_TOOL = /^(Edit|Write|MultiEdit|NotebookEdit)$/;

/**
 * The command without the text it only carries: heredoc bodies and quoted strings. A gate quoted inside
 * an `echo '{…"pnpm lint && pnpm test"…}' | node hook.mjs` probe is data, not a run.
 */
export function bareCommand(command) {
  return String(command)
    .replace(/<<-?\s*['"]?(\w+)['"]?[^\n]*\n[\s\S]*?\n\s*\1\b/g, ' ')
    .replace(/'[^']*'|"(?:\\.|[^"\\])*"/g, ' ');
}

/**
 * A segment's text that can name a check: the command word plus its non-path arguments. A path
 * argument is a target, not a runner — `vitest run src/project-tests/lint` is one test run, not
 * lint + test; `.test.`/`.spec.` inside a file name is no test run either (`eslint a.test.ts`).
 */
function checkText(seg) {
  const s = seg
    .replace(TRUNCATED, ' ')
    .replace(/^\s*(?:do|then|else)\s+/, '')
    .trim();
  const [head = '', ...rest] = s.split(/\s+/);
  return [head, ...rest.filter((t) => !/[\\/]/.test(t))]
    .join(' ')
    .replace(/[.\-_](?:test|spec)(?=\.\w)/gi, '');
}

/** Kinds of check a command batches; a gate script counts as every kind. */
export function gateKinds(command) {
  const kinds = new Set();
  for (const seg of bareCommand(command).split(/&&|\|\||;|\n/)) {
    const s = checkText(seg);
    if (!s || NOT_CHECK.test(s)) continue;
    // The gate runner is named by its path (`node <kit>/tools/gate-run.mjs`), so the whole segment.
    if (GATE_SCRIPT.test(seg) || projectGateScript(seg)) kinds.add('gate');
    for (const [name, re] of KINDS) if (re.test(s)) kinds.add(name);
  }
  return kinds;
}

// Already narrowed: file arguments, a subfolder (`src/domains/chat/`), a related/changed run, a name
// filter, one workspace package, a file list from a variable or a substitution (`eslint $F`).
const NARROW =
  /\s(?:related|--changed|--findRelatedTests|--onlyChanged|-t|--testNamePattern|--grep|-k|--filter|-F|--dir|--project|--incremental|--tsBuildInfoFile)\b|\s(?:\.{0,2}[\\/])?[\w@.-]+(?:[\\/][\w@.[\]-]+)*\.(?:[cm]?[jt]sx?|vue|svelte|py|go|css|scss)\b|\s(?:\.{0,2}[\\/])?[\w@.-]+[\\/][\w@.[\]-]+|\s\$[\w{(]|\b(?:vitest(?:\s+run)?|jest)\s+(?!-|run\b|\d*>)[\w@.-]+/i;
const WHOLE_DIR = /\s(?:\.|\.\/|src|app|apps|packages|lib)\s*(?:$|\s)/;
// Type-check of one package: `tsc -p packages/food`, `cd apps/server && npx tsc` — the narrow form the
// deny texts themselves recommend; a root `-p tsconfig.app.json` stays whole.
const TYPES_NARROW = /--incremental|--tsBuildInfoFile|--filter|-F\b|\s-p\s+\S*[\\/]|\s\$[\w{(]/;
const PACKAGE_CD = /(?:^|&&|;)\s*cd\s+["']?[\w.@~-]+[\\/][^\s;&]*/;

/** Every check segment of the command already runs narrow (file args, a filter, one package). */
export function allNarrow(command) {
  const bare = bareCommand(command);
  const checks = bare
    .split(/&&|\|\||;|\n/)
    .map((seg) => ({ seg, kinds: [...gateKinds(seg)] }))
    .filter((c) => c.kinds.length > 0);
  if (!checks.length) return false;
  const inPackage = PACKAGE_CD.test(bare);
  return checks.every(({ seg, kinds }) => {
    if (kinds.some((k) => !['types', 'lint', 'test'].includes(k))) return false;
    // `node scripts/lint.mjs` — the script's own path is the command, not a file argument.
    const s = seg.replace(/\b(node|tsx|bun|deno(?:\s+run)?)\s+\S+/gi, '$1');
    return kinds.every((k) =>
      k === 'types' ? inPackage || TYPES_NARROW.test(s) : NARROW.test(s) && !WHOLE_DIR.test(s),
    );
  });
}

/**
 * Full gate = a gate script, or two or more check kinds of which at least one runs whole. A pair of
 * narrow checks (`vitest run a.test.ts && eslint a.ts`) is exactly what the follow-up texts recommend;
 * counted as a gate it was denied in the foreground and then as "already ran" (54 a week, p50 18 s).
 */
export function isFullGate(command) {
  const kinds = gateKinds(command);
  return kinds.has('gate') || (kinds.size >= 2 && !allNarrow(command));
}

/**
 * The text of a shell script the command runs (`bash .agent/tmp/gate.sh`), ≤64 KB, else ''. A gate
 * moved into a script file was invisible: one session ran the same scratch gate script five times.
 */
export function scriptText(command, cwd) {
  const m = /(?:^|&&|;|\n)\s*(?:bash|sh|zsh)\s+(?:-\w+\s+)*["']?([^\s"';&|]+\.sh)\b/.exec(
    bareCommand(command),
  );
  if (!m) return '';
  try {
    const file = isAbsolute(m[1]) ? m[1] : join(String(cwd ?? process.cwd()), m[1]);
    if (statSync(file).size > 64 * 1024) return '';
    return readFileSync(file, 'utf8')
      .split('\n')
      .filter((l) => !/^\s*#/.test(l))
      .join('\n');
  } catch {
    return '';
  }
}

const isGateRun = (command, cwd) => isFullGate(command) || isFullGate(scriptText(command, cwd));

function statePath(input) {
  const session = sessionKey(input);
  const dir = session ? stateDir('gates') : null;
  return dir ? join(dir, `${session}.json`) : null;
}

function loadState(path) {
  if (!path) return { runs: [] };
  try {
    const s = JSON.parse(readFileSync(path, 'utf8'));
    return Array.isArray(s?.runs) ? s : { runs: [] };
  } catch {
    return { runs: [] };
  }
}

function saveState(path, state) {
  if (!path) return;
  try {
    writeFileSync(path, JSON.stringify({ runs: state.runs.slice(-20) }));
  } catch {
    /* state is an optimisation; the transcript stays the primary source */
  }
}

function looksRed(res) {
  if (res.isError) return true;
  const body = res.body || '';
  if (/^\s*Exit code [1-9]/m.test(body)) return true;
  // `(?:\b|_)`: `GATE_EXIT=1` has no word boundary before EXIT and read green (18.10).
  if (/(?:\b|_)EXIT(?:_CODE)?\s*[=:]\s*[1-9]/i.test(body)) return true;
  // `echo "GATE EXIT $?"` — code after a space, upper case only: «exit 1» in prose is not a verdict.
  if (/(?:\b|_)EXIT(?:_CODE)?\s+[1-9]\d*\s*$/m.test(body)) return true;
  if (/error TS\d{3,}/.test(body)) return true;
  if (/\b\d+\s+(failed|failing|errors?)\b/i.test(body) && !/\b0\s+(failed|errors?)\b/i.test(body))
    return true;
  return /✖|\bFAIL\b|ELIFECYCLE/.test(body);
}

/** The command's own exit code cannot reach the notification: `; echo …`, `|| true`, `; exit 0`. */
const MASKED_EXIT = /;\s*(?:echo|printf|true|exit\s+0)\b|\|\|\s*(?:true|:|echo|exit\s+0)\b/;

function tailOf(file, cwd, bytes = 20_000) {
  try {
    const path = isAbsolute(file) ? file : join(String(cwd ?? process.cwd()), file);
    const text = readFileSync(path, 'utf8');
    return text.slice(-bytes);
  } catch {
    return '';
  }
}

/**
 * `cd <dir>; …` / `cd <dir> && …` at the head: a relative log lives under that dir, not under the
 * session's cwd — which had moved on, so the log was not found and a red gate read green (18.10).
 */
function commandCwd(command, cwd) {
  const m = /^\s*cd\s+(?:"([^"]+)"|'([^']+)'|([^\s;&|]+))\s*(?:;|&&)/.exec(command);
  const target = m?.[1] ?? m?.[2] ?? m?.[3];
  if (!target) return cwd;
  // Git Bash on Windows: `/c/work/x` → `c:/work/x`.
  const native =
    process.platform === 'win32' ? target.replace(/^\/([a-zA-Z])(?=\/|$)/, '$1:') : target;
  return isAbsolute(native) ? native : join(String(cwd ?? process.cwd()), native);
}

/**
 * Outcome of a background run arrives as a task notification, not as the tool result. Its exit code
 * alone lies when the gate masks it (`… > gate.log 2>&1; echo EXIT=$?` always exits 0 — a red gate
 * was taken for green and its fix re-run denied), so the output file and a redirected log are read too.
 */
function backgroundOutcome(rawTail, taskId, command, cwd) {
  if (!taskId) return null;
  const at = rawTail.lastIndexOf(`<task-id>${taskId}</task-id>`);
  if (at < 0) return null;
  const note = rawTail.slice(at, at + 1500);
  if (/<status>killed<\/status>|<status>stopped<\/status>/.test(note)) return 'stopped';
  if (/exit code [1-9]|<status>failed<\/status>/i.test(note)) return 'red';
  // An honest exit code is trusted as is: a warnings-only lint prints ✖ and still passes.
  if (!MASKED_EXIT.test(bareCommand(command))) return 'green';
  const output = /<output-file>([^<]+)<\/output-file>/.exec(note)?.[1]?.trim();
  // Every redirect target: with `> cases.log … > gate.log` only the first was read and a red gate
  // whose verdict sat in the second read green (18.10).
  const logs = [
    ...command.matchAll(/(?:^|\s)\d?>{1,2}\s*["']?([^\s"'&|;]+\.(?:log|txt|out))/g),
  ].map((m) => m[1]);
  const body = [output, ...new Set(logs)]
    .filter(Boolean)
    .map((f) => tailOf(f, commandCwd(command, cwd)))
    .join('\n');
  return looksRed({ isError: false, body }) ? 'red' : 'green';
}

/** Previous full gates, newest last: from the transcript tail, merged with the saved state. */
function previousGates(events, rawTail, state, cwd) {
  const seen = new Map(state.runs.map((r) => [r.id, { ...r, index: -1 }]));
  events.forEach((e, i) => {
    if (
      e.kind !== 'use' ||
      !/^(Bash|PowerShell)$/.test(String(e.name)) ||
      !isGateRun(e.input?.command ?? '', cwd)
    )
      return;
    const res = resultFor(events.slice(i), e.id);
    if (!res || res.body.includes('[ctx-guard]')) return; // refused or still running in the foreground
    let outcome = looksRed(res) ? 'red' : 'green';
    const bg = /running in background with ID:\s*(\w+)/i.exec(res.body);
    if (bg) outcome = backgroundOutcome(rawTail, bg[1], e.input?.command ?? '', cwd) ?? 'running';
    const taskId = bg?.[1] ?? null;
    const ts = e.ts ?? Date.now();
    // A saved entry without the tool_use_id (older CLI) is the same run seconds later — drop it.
    for (const [id, r] of seen) if (r.index < 0 && Math.abs(r.ts - ts) < 15_000) seen.delete(id);
    seen.set(e.id, { id: e.id, ts, outcome, index: i, taskId });
  });
  return [...seen.values()].filter((r) => r.outcome !== 'stopped').sort((a, b) => a.ts - b.ts);
}

function editsAfter(events, index) {
  // A run older than the tail (known only from state): every edit in the tail came after it.
  const from = index < 0 ? 0 : index + 1;
  return events.slice(from).filter((e) => e.kind === 'use' && EDIT_TOOL.test(String(e.name)))
    .length;
}

/** Full gates of this session, oldest first — for the prompt hint. [] on any read failure. */
export function sessionGates(input) {
  try {
    const raw = readTailText(input?.transcript_path, 4_000_000);
    return previousGates(
      toolEvents(readTail(input.transcript_path)),
      raw,
      loadState(statePath(input)),
      input?.cwd,
    );
  } catch {
    return [];
  }
}

/**
 * True the first time it is asked about this finished gate, false after: the follow-up hint is said once
 * per gate instead of being re-billed on every later prompt (~400 chars each, owner audit 18.10.2026).
 */
export function firstHintFor(input, ts) {
  const path = statePath(input);
  if (!path) return true;
  const mark = path.replace(/\.json$/, '.hinted');
  try {
    if (readFileSync(mark, 'utf8') === String(ts)) return false;
  } catch {
    /* never hinted */
  }
  try {
    writeFileSync(mark, String(ts));
  } catch {
    /* best effort: a lost mark repeats the hint once */
  }
  return true;
}

export const hhmm = (ts) => new Date(ts).toTimeString().slice(0, 5);

// Panel split group (owner 23.10): ONE full gate per group, in its delivery stage. Every stage is a new
// session, so "the first full gate of the session is free" restarted at each stage: the 23.10 day ran
// full gates 113× in work stages, 22× in review, 36× in fix against 33× in delivery — often on one tree.
// The panel names the stage (AGENTDECK_GROUP_STAGE) and whether a delivery stage follows
// (AGENTDECK_GROUP_DELIVER_AHEAD=1); a per-copy ledger keyed by the working tree spans the stages.
const groupStage = () => String(process.env.AGENTDECK_GROUP_STAGE ?? '').trim();
const deliverAhead = () => process.env.AGENTDECK_GROUP_DELIVER_AHEAD === '1';
const groupSession = () => Boolean(groupStage() || process.env.AGENTDECK_HEAVY_QUEUE_DIR);

/**
 * Segments of a shell command, each a list of words with their quotes kept: split on unquoted
 * `&&`, `||`, `;`, `|`, `(`, `)` and newlines; heredoc bodies dropped (they are data).
 */
function shellSegments(command) {
  const text = String(command).replace(/<<-?\s*['"]?(\w+)['"]?[^\n]*\n[\s\S]*?\n\s*\1\b/g, ' ');
  const segments = [];
  let words = [];
  let word = '';
  let quote = '';
  const endWord = () => {
    if (word) words.push(word);
    word = '';
  };
  const endSegment = () => {
    endWord();
    if (words.length) segments.push(words);
    words = [];
  };
  for (let i = 0; i < text.length; i += 1) {
    const c = text[i];
    if (quote) {
      word += c;
      if (c === quote) quote = '';
      continue;
    }
    if (c === '"' || c === "'") {
      quote = c;
      word += c;
    } else if (/[\s]/.test(c)) {
      if (c === '\n') endSegment();
      else endWord();
    } else if (';|&()'.includes(c)) {
      // `2>&1` / `&>` stay inside a word: `&` right after `>` or before `>` is a redirect.
      if (c === '&' && (text[i - 1] === '>' || text[i + 1] === '>')) word += c;
      else endSegment();
    } else word += c;
  }
  endSegment();
  return segments;
}

const unquote = (s) => String(s).replace(/^(["'])([\s\S]*)\1$/, '$2');
const LEDGER_NAME = /^AGENTDECK_VERIFY_LEDGER(?:_LOCK|_HOME|_DELTA)?$/i;

/**
 * NODE_OPTIONS named as a variable — not a file (`node_options.test.ts`) or a longer identifier.
 * Case-insensitive: Windows environment names are (`$env:node_options`, cmd's `set`).
 */
const NODE_OPTIONS_MENTION = /(?<![A-Za-z0-9_\-/])NODE_OPTIONS(?![A-Za-z0-9_]|\.[A-Za-z])/gi;
/**
 * An expansion that yields the inherited value whole, preload included: `$NODE_OPTIONS`,
 * `${NODE_OPTIONS}`, `${NODE_OPTIONS:-…}`, `$env:NODE_OPTIONS`, `%NODE_OPTIONS%`. Every other
 * expansion (`${NODE_OPTIONS%%--require*}`, `${NODE_OPTIONS/x/y}`, `${NODE_OPTIONS:0:0}`) rewrites it.
 */
const BARE_NODE_OPTIONS =
  /\$NODE_OPTIONS(?![A-Za-z0-9_])|\$\{NODE_OPTIONS(?::?-[^}]*)?\}|\$env:NODE_OPTIONS(?![A-Za-z0-9_])|%NODE_OPTIONS%/gi;
const count = (text, re) => (String(text).match(re) ?? []).length;

/** Heads that only read or print: a NODE_OPTIONS in their words is text, not a change. */
const READERS =
  /^(?:echo|printf|printenv|grep|egrep|fgrep|rg|ag|cat|head|tail|less|more|wc|sort|uniq|diff|findstr|Select-String|sls|Get-Content|gc|type|ls|dir|stat|which|where|file|Write-Output|Write-Host)$/i;
const GIT_READS = /^(?:grep|log|show|diff|blame|status|commit|add|shortlog|ls-files)$/;

function readsOnly(words) {
  const list = words.map(unquote);
  const head = list[0] ?? '';
  // `printf -v NODE_OPTIONS ''` assigns.
  if (/^printf$/i.test(head)) return !list.some((w) => /^-v/.test(w));
  if (READERS.test(head)) return true;
  if (!/^git$/i.test(head) || !GIT_READS.test(list[1] ?? '')) return false;
  // A pager, filter or config value is a program git runs: `-O<cmd>`, `--open-files-in-pager`, `-c`.
  return !list.some((w) => /^(?:-c|-O|--open-files-in-pager|--ext-diff|--textconv|--exec)/.test(w));
}

/** The value keeps the inherited NODE_OPTIONS: `+=` appends; `=` needs only bare expansions in it. */
function keepsNodeOptions(raw, append) {
  if (append) return true;
  // Single quotes do not expand: `NODE_OPTIONS='$NODE_OPTIONS'` is the literal text.
  if (/'[^']*NODE_OPTIONS/i.test(raw)) return false;
  const bare = count(raw, BARE_NODE_OPTIONS);
  return bare > 0 && bare === count(raw, NODE_OPTIONS_MENTION);
}

/**
 * The segment changes NODE_OPTIONS for what it runs (RF-BGCD-08). Inverted on purpose: the old rule
 * listed the changing forms and every unlisted one passed (`export -n`, `declare +x`, `bash -c`, `eval`,
 * `nice`, `npx --yes cross-env`, `cmd //c set`, `Clear-Item`, `[Environment]::Set…`, `delete
 * process.env…`, a rewriting expansion). Now a mention passes only as a bare expansion, as an
 * assignment that keeps one, or in a segment that only reads.
 */
function dropsNodeOptions(words) {
  const mentions = (w) => count(w, NODE_OPTIONS_MENTION) > 0;
  if (!words.some(mentions) || readsOnly(words)) return false;
  for (let i = 0; i < words.length; i += 1) {
    const raw = words[i];
    if (!mentions(raw)) continue;
    const assign =
      /^(?:\$env:)?NODE_OPTIONS(\+?)=([\s\S]*)$/i.exec(raw) ??
      /^(?:\$env:)?NODE_OPTIONS(\+?)=([\s\S]*)$/i.exec(unquote(raw));
    if (assign) {
      if (!keepsNodeOptions(assign[2], assign[1] === '+')) return true;
      continue;
    }
    // PowerShell with spaces: `$env:NODE_OPTIONS = '…'`, `$env:NODE_OPTIONS += '…'`.
    if (/^\$env:NODE_OPTIONS$/i.test(raw) && /^\+?=$/.test(words[i + 1] ?? '')) {
      const append = words[i + 1] === '+=';
      if (!keepsNodeOptions(words[i + 2] ?? '', append)) return true;
      i += 2;
      continue;
    }
    if (
      count(raw, BARE_NODE_OPTIONS) === count(raw, NODE_OPTIONS_MENTION) &&
      !/'[^']*NODE_OPTIONS/i.test(raw)
    )
      continue;
    return true;
  }
  return false;
}

/** Command text a segment hands to another shell: `bash -c '…'`, `eval …`, `cmd /c …`, `pwsh -c …`. */
function nestedCommand(words) {
  const list = words.map(unquote);
  const head = list[0] ?? '';
  if (/^(?:ba|z|da|k)?sh(?:\.exe)?$/i.test(head)) {
    const at = list.findIndex((w, i) => i > 0 && /^-\w*c$/.test(w));
    return at > 0 ? (list[at + 1] ?? '') : null;
  }
  if (/^eval$/i.test(head)) return list.slice(1).join(' ');
  if (/^cmd(?:\.exe)?$/i.test(head)) {
    const at = list.findIndex((w, i) => i > 0 && /^\/\/?[ck]$/i.test(w));
    return at > 0 ? list.slice(at + 1).join(' ') : null;
  }
  if (/^(?:pwsh|powershell)(?:\.exe)?$/i.test(head)) {
    const at = list.findIndex((w, i) => i > 0 && /^-(?:c|command)$/i.test(w));
    return at > 0 ? list.slice(at + 1).join(' ') : null;
  }
  return null;
}

/** Words that only wrap the command after them: `nice`, `time`, `npx --yes`, `pnpm dlx`, `timeout 60`. */
const WRAPPER =
  /^(?:npx|pnpm|pnpx|dlx|exec|command|sudo|nice|time|nohup|timeout|stdbuf|ionice|chrt|yes|bunx)$/i;

/**
 * Why the command switches the verify ledger off for what it runs, or `null` (F-30, F-37). Only the
 * forms that change the environment count — an assignment or unset in the command's prefix
 * (`X=…`, `export X=…`, `$env:X=…`, `set X=…`, `env -u X`, `unset X`, `env -i`) — so a `grep` that
 * merely names the lock reads the panel's own code freely. Watched: the ledger's switch, narrowing
 * and lock (`AGENTDECK_VERIFY_LEDGER[_DELTA|_LOCK]`), its home (`_HOME` — a fresh home holds no
 * green to replay and no key to trust one) and `NODE_OPTIONS`, which carries the preload itself
 * (`dropsNodeOptions`: any form but a bare expansion). A segment handing text to another shell is
 * read through (`bash -c`, `eval`, `cmd /c`, `pwsh -c`). Left out deliberately: a program that
 * rewrites its own environment from a file (`node script.js` doing `delete process.env…`) — catching
 * it needs the run itself; a runtime check on the preload's own record would refuse every gate whose
 * checks are not Node.
 */
export function ledgerEscape(command, depth = 0) {
  const touched = (name, value) => {
    const bare = name.toUpperCase();
    if (!LEDGER_NAME.test(bare)) return null;
    // `=on` keeps the ledger as it is; any other value, an empty one or an unset turns it off.
    if (/^AGENTDECK_VERIFY_LEDGER(?:_DELTA)?$/.test(bare) && unquote(value ?? '') === 'on')
      return null;
    return bare;
  };
  for (const words of shellSegments(command)) {
    if (dropsNodeOptions(words)) return 'NODE_OPTIONS (it carries the ledger preload)';
    const nested = depth < 4 ? nestedCommand(words) : null;
    if (nested) {
      const hit = ledgerEscape(nested, depth + 1);
      if (hit) return hit;
      continue;
    }
    let at = 0;
    const head = () => unquote(words[at] ?? '');
    // `npx --yes cross-env X=…`, `nice -n 5 …`, `export`, `declare -x`, cmd's `set`, `Remove-Item env:X`.
    while (WRAPPER.test(head()) || (at > 0 && /^(?:-\S*|\d+[smhd]?)$/.test(head()))) at += 1;
    if (/^(?:unset|Remove-Item|rm|ri|del)$/i.test(head())) {
      for (const word of words.slice(at + 1)) {
        const name = unquote(word).replace(/^env:[\\/]?/i, '');
        if (/^-/.test(name)) continue;
        const hit = touched(name, undefined);
        if (hit && (/^unset$/i.test(head()) || /^env:/i.test(unquote(word)))) return hit;
      }
      continue;
    }
    if (/^(?:export|declare|typeset|local|readonly|set)$/i.test(head())) {
      at += 1;
      while (/^-/.test(head())) at += 1;
    }
    const env = /^(?:env|cross-env)$/i.test(head());
    if (env) at += 1;
    for (; at < words.length; at += 1) {
      const word = unquote(words[at]);
      if (env && /^(?:-i|--ignore-environment|-)$/.test(word))
        return 'the whole environment (env -i)';
      const unset = env ? /^(?:-u|--unset)(?:=(.+))?$/.exec(word) : null;
      if (unset) {
        const name = unset[1] ?? unquote(words[(at += 1)] ?? '');
        const hit = touched(name, undefined);
        if (hit) return hit;
        continue;
      }
      if (env && /^-/.test(word)) continue;
      // `$env:X='…'`, `$env:X = '…'`, `X=…`.
      const ps = /^\$env:(\w+)(?:=([\s\S]*))?$/i.exec(word);
      if (ps) {
        const value = ps[2] ?? (words[at + 1] === '=' ? (words[at + 2] ?? '') : undefined);
        if (value === undefined) break;
        const hit = touched(ps[1], unquote(value));
        if (hit) return hit;
        break;
      }
      const assign = /^(\w+)=([\s\S]*)$/.exec(word);
      if (!assign) break;
      const hit = touched(assign[1], unquote(assign[2]));
      if (hit) return hit;
    }
  }
  return null;
}

/** The gate as the copy's ledger keys it (F-36): the command, without a `cd` in front or its logs. */
export function gateKey(command) {
  return String(command)
    .replace(/^\s*cd\s+(?:"[^"]*"|'[^']*'|[^\s;&|]+)\s*(?:;|&&)/, '')
    .replace(/\s+(?:\d?>{1,2}|&>)\s*(?:&\d|"[^"]*"|'[^']*'|[^\s;&|]+)/g, ' ')
    .replace(/;\s*echo\b[^;&|]*$/, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function git(cwd, args, env) {
  return execFileSync('git', args, {
    cwd,
    env: env ?? process.env,
    encoding: 'utf8',
    timeout: 15_000,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'ignore'],
  }).trim();
}

/** Ignored files every JS check reads (the verify ledger's set): `.env*` and node_modules' hidden locks. */
const HIDDEN_LOCKS = [
  'node_modules/.package-lock.json',
  'node_modules/.modules.yaml',
  'node_modules/.pnpm/lock.yaml',
];

/**
 * F-80: `add -A` follows .gitignore, so a changed `.env.local` or a reinstalled node_modules left the
 * tree key as it was and replayed the old verdict. Their contents join the key — only these: the
 * gate's own logs and build outputs are ignored too and change on every run. '' when none exist.
 * Anywhere in the copy (RF-BGCD-12d), not only the top and the cwd: a monorepo keeps `apps/*\/.env*`
 * and a node_modules per package. The list is git's own (`ls-files --others --ignored --directory`):
 * an ignored `node_modules/` comes as one entry, so the walk does not descend into it.
 */
function ignoredInputsDigest(top) {
  const hash = createHash('sha256');
  let any = false;
  let listed;
  try {
    listed = execFileSync(
      'git',
      ['ls-files', '-z', '--others', '--ignored', '--exclude-standard', '--directory'],
      {
        cwd: top,
        encoding: 'utf8',
        timeout: 15_000,
        windowsHide: true,
        maxBuffer: 32 * 1024 * 1024,
        stdio: ['ignore', 'pipe', 'ignore'],
      },
    )
      .split('\0')
      .filter(Boolean);
  } catch {
    return '';
  }
  const files = [];
  for (const entry of listed) {
    const name = entry.replace(/\/$/, '').split('/').pop() ?? '';
    if (entry.endsWith('/') && name === 'node_modules') {
      const dir = entry.slice(0, -'node_modules/'.length);
      files.push(...HIDDEN_LOCKS.map((lock) => `${dir}${lock}`));
    } else if (!entry.endsWith('/') && /^\.env/.test(name)) files.push(entry);
  }
  for (const rel of [...new Set(files)].sort()) {
    try {
      const body = readFileSync(join(top, rel));
      hash.update(`${rel}\0`).update(body);
      any = true;
    } catch {
      /* absent or a directory */
    }
  }
  return any ? hash.digest('hex').slice(0, 12) : '';
}

/**
 * The copy's working tree as a commit would take it now — `add -A` into a scratch copy of the index,
 * then `write-tree` — and its own git dir (a worktree's, so the ledger is per copy and outside the
 * tree). `null` outside git or on any git failure: then no ledger, the session rules alone.
 */
export function copyTree(cwd) {
  let scratch = '';
  try {
    const gitDir = git(cwd, ['rev-parse', '--absolute-git-dir']);
    scratch = join(tmpdir(), `agentdeck-gate-${process.pid}-${Date.now()}.index`);
    try {
      copyFileSync(join(gitDir, 'index'), scratch);
    } catch {
      /* no index yet: add -A builds it from scratch */
    }
    const env = { ...process.env, GIT_INDEX_FILE: scratch };
    git(cwd, ['add', '-A'], env);
    const tree = git(cwd, ['write-tree'], env);
    const ignored = ignoredInputsDigest(git(cwd, ['rev-parse', '--show-toplevel']));
    // Where in the copy the gate runs (RF-BGCD-11): `cd backend && pnpm gate` and
    // `cd frontend && pnpm gate` are one key without it, on one whole-copy tree.
    const prefix = git(cwd, ['rev-parse', '--show-prefix']).replace(/\/$/, '');
    return { gitDir, tree: ignored ? `${tree}+${ignored}` : tree, prefix };
  } catch {
    return null;
  } finally {
    if (scratch) rmSync(scratch, { force: true });
  }
}

const ledgerPath = (gitDir) => join(gitDir, 'agentdeck-gates.json');

/** A full gate takes 13–20 min; a background one with no result an hour later died with its stage. */
const RUNNING_STALE_MS = 60 * 60_000;

function loadLedger(gitDir) {
  try {
    const s = JSON.parse(readFileSync(ledgerPath(gitDir), 'utf8'));
    return Array.isArray(s?.runs) ? s.runs : [];
  } catch {
    return [];
  }
}

function saveLedger(gitDir, runs) {
  try {
    writeFileSync(ledgerPath(gitDir), JSON.stringify({ runs: runs.slice(-30) }));
  } catch {
    /* best effort: a lost entry only lets one more gate through */
  }
}

/** Outcome of a ledger entry, read from the transcript of the stage that ran it; `null` = unknown. */
function ledgerOutcome(entry, cwd) {
  try {
    const raw = readTailText(entry.transcript, 4_000_000);
    const runs = previousGates(toolEvents(readTail(entry.transcript)), raw, { runs: [] }, cwd);
    return runs.find((r) => r.id === entry.id)?.outcome ?? null;
  } catch {
    return null;
  }
}

export default function gateAtEnd(input) {
  const tool = input?.tool_name;
  if (tool !== 'Bash' && tool !== 'PowerShell') return null;
  if (inSubagent(input)) return null;
  const command = String(input.tool_input?.command ?? '');
  // The verify ledger's replay of a green run on the same tree is the panel's (owner 23.10): a group
  // switched it off in its own command and paid the same gate again. The panel's lock lives in the
  // preload's entry path (F-30), so `off`, `_LOCK=` or `_HOME=` reach nothing even through a script;
  // what still would — dropping the preload from NODE_OPTIONS, `env -i` — is refused here, no repeat.
  // The script the command runs is read too (RF-BGCD-08): `bash gate.sh` with `unset NODE_OPTIONS` in it.
  const escape = groupSession()
    ? (ledgerEscape(command) ?? ledgerEscape(scriptText(command, input.cwd)))
    : null;
  if (escape) {
    return deny(
      `gate-at-end: the verify ledger is not switched off from a panel group (this command changes ${escape}). ` +
        'A "[verify-ledger] reused green" line means nothing the check depends on changed since that green run — ' +
        "its output and exit code ARE this run's. Need a fresh run? Change the code it checks; otherwise use the " +
        'reused result. Extra Node flags go after the inherited ones: NODE_OPTIONS="$NODE_OPTIONS --flag" ' +
        '(or NODE_OPTIONS+=" --flag"); to read it: echo "$NODE_OPTIONS" or printenv NODE_OPTIONS.',
    );
  }
  if (!isGateRun(command, input.cwd)) return null;

  // Not escapable by a repeat: the delivery stage that follows is where the gate runs, and a repeat
  // here would only spend the 13–20 min run twice.
  const stage = groupStage();
  if (stage && stage !== 'deliver' && deliverAhead()) {
    return deny(
      `gate-at-end: this is the ${stage} stage of a panel split group, and a delivery stage follows it: the ` +
        "group's full project checks run ONCE, there, on the final tree. That run is what satisfies a project " +
        'rule asking for full checks before "done". Here check only what you touched: the tests of the touched ' +
        'files (`vitest related <files> --run`, `pytest <file>`), lint and type-check of those files or their package.',
    );
  }

  let raw;
  let records;
  try {
    raw = readTailText(input.transcript_path, 4_000_000);
    records = readTail(input.transcript_path);
  } catch {
    return null;
  }
  const events = toolEvents(records);
  const key = command.replace(/\s+/g, ' ').trim();
  if (
    wasJustRefused(
      events,
      tool,
      (other) =>
        String(other?.command ?? '')
          .replace(/\s+/g, ' ')
          .trim() === key,
    )
  )
    return null;

  // Foreground stays the rule where background is not wanted: a split group (the panel reads the end
  // of its turn as the result) and a local-model run (local-discipline refuses background shells).
  // A CLI whose shell has no background flag (Codex) keeps the foreground too — nothing to obey.
  const bgParam = backgroundParam(input);
  const group =
    Boolean(process.env.AGENTDECK_HEAVY_QUEUE_DIR) ||
    (process.env.AGENTDECK_KIT_VARIANT ?? '').trim() === 'local' ||
    !bgParam;
  const bg = input.tool_input?.run_in_background === true;
  if (!group && (!bg || TRUNCATED.test(command))) {
    return deny(
      `gate-at-end: a full gate runs with ${bgParam}:true and its whole output (no | tail/head/grep; ` +
        'for a log file add `> .agent/tmp/gate.log 2>&1`). A foreground gate dies at the 600 s tool cap, a truncated ' +
        'one gets re-run just to be read, and only a background gate can be stopped (TaskStop) if the task grows ' +
        'while it runs. After starting it: do the remaining non-code work or end the turn saying the gate is running; ' +
        'the completion notification wakes you — never sleep-poll. Repeat this exact call only if it must stay as is.',
    );
  }

  // A group stage: the same full gate already run on exactly this tree — in this stage or an earlier
  // one — is authoritative; its result is read, not produced again. The same gate, not any (F-36): a
  // green `check_backend.py` says nothing about `check_frontend.mjs`; an entry from before the command
  // was keyed names no gate and counts for none.
  const id = String(input.tool_use_id ?? `t${Date.now()}`);
  const copy = stage ? copyTree(commandCwd(command, input.cwd) ?? process.cwd()) : null;
  // The copy's subdirectory joins the key (RF-BGCD-11); at the top it stays the bare command, as before.
  const cmd = copy?.prefix ? `${copy.prefix}: ${gateKey(command)}` : gateKey(command);
  const ledger = copy ? loadLedger(copy.gitDir) : [];
  for (const entry of [...ledger].reverse()) {
    if (entry.tree !== copy?.tree || entry.cmd !== cmd || entry.id === id) continue;
    const outcome = ledgerOutcome(entry, input.cwd);
    if (!outcome) continue;
    const where = `at ${hhmm(entry.ts)} in the ${entry.stage ?? 'previous'} stage`;
    if (outcome === 'running') {
      // F-79: a stage whose session died never gets the notification — its entry would read
      // "running" forever and hold every later stage on this tree. Past RUNNING_STALE_MS it is gone.
      if (Date.now() - Number(entry.ts ?? 0) > RUNNING_STALE_MS) continue;
      return deny(
        `gate-at-end: a full gate on exactly this tree started ${where} is still running. Wait for its ` +
          'result instead of starting a second one. Repeat this exact call only if that run is gone ' +
          '(its stage ended without a result).',
      );
    }
    return deny(
      `gate-at-end: the full gate already ran on exactly this tree (git tree ${copy.tree.slice(0, 12)}) ${where} — ` +
        `${outcome}. That result is authoritative: read it (transcript ${entry.transcript}, tool_use_id ${entry.id}, ` +
        'or its log) instead of re-running; red → fix, then re-run only the red checks, narrowly. Repeat this ' +
        'exact call only for a suspected flaky run.',
    );
  }

  const path = statePath(input);
  const state = loadState(path);
  const runs = previousGates(events, raw, state, input.cwd);
  // Outcomes learned from the tail go back into the state: a red gate saved as 'unknown' read as green
  // once its run scrolled out of the tail.
  let learnedOutcome = false;
  for (const r of state.runs) {
    const known = runs.find((x) => x.id === r.id && x.index >= 0);
    if (
      known &&
      (known.outcome === 'red' || known.outcome === 'green') &&
      r.outcome !== known.outcome
    ) {
      r.outcome = known.outcome;
      learnedOutcome = true;
    }
  }
  if (learnedOutcome) saveState(path, state);
  const prev = runs[runs.length - 1];
  const prompt = String(currentUserPrompt(input, records) ?? '');

  if (prev?.outcome === 'running') {
    return deny(
      `gate-at-end: a full gate started at ${hhmm(prev.ts)} is still running in the background. Wait for its ` +
        'notification. If the task grew since it started, stop it (TaskStop), finish the new work, then run the full ' +
        'gate once.',
    );
  }
  if (prev) {
    const edits = editsAfter(events, prev.index);
    if (edits === 0) {
      return deny(
        `gate-at-end: nothing was edited since the full gate at ${hhmm(prev.ts)} (${prev.outcome}). Its output is ` +
          'already there — read it (the task output file or the log) instead of re-running. Repeat this exact call ' +
          'only for a suspected flaky run.',
      );
    }
    // 'unknown' = a run known only from state (its result scrolled out with a compaction): it ran,
    // so it counts like a green one — a red one would have been fixed and re-run inside the tail.
    if (prev.outcome !== 'red' && !DELIVERY.test(prompt)) {
      return deny(
        `gate-at-end: the full gate already ran at ${hhmm(prev.ts)} (${prev.outcome}); ${edits} edit(s) since belong to a ` +
          'follow-up of the same task. Check them narrowly — the tests of the touched files (`vitest related <files> ' +
          '--run`, `pytest <file>`), lint and type-check of those files or their package. The full gate runs ONCE more, ' +
          'at delivery: when the user asks to commit, push or open an MR, or closes the task. Say in the summary ' +
          'that the full gate runs at delivery. Repeat this exact call if delivery is happening now.',
      );
    }
  }

  // Allowed: remember it so the decision survives compaction.
  state.runs = state.runs.filter((r) => r.id !== id);
  state.runs.push({ id, ts: Date.now(), outcome: 'unknown' });
  saveState(path, state);
  if (copy && input.transcript_path) {
    saveLedger(copy.gitDir, [
      ...ledger.filter((r) => r.id !== id),
      { tree: copy.tree, cmd, id, transcript: input.transcript_path, ts: Date.now(), stage },
    ]);
  }
  return null;
}
