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
import { readFileSync, statSync, writeFileSync } from 'node:fs';
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
const GATE_SCRIPT =
  /\b(npm|pnpm|yarn|bun)\s+(run\s+)?(gate|verify|ci|validate|check-all)\b|\bmake\s+(check|ci|verify|gate)\b|\bgate-run(\.mjs)?\b/i;
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
    if (GATE_SCRIPT.test(seg)) kinds.add('gate');
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

export default function gateAtEnd(input) {
  const tool = input?.tool_name;
  if (tool !== 'Bash' && tool !== 'PowerShell') return null;
  if (inSubagent(input)) return null;
  const command = String(input.tool_input?.command ?? '');
  if (!isGateRun(command, input.cwd)) return null;

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
  const id = String(input.tool_use_id ?? `t${Date.now()}`);
  state.runs = state.runs.filter((r) => r.id !== id);
  state.runs.push({ id, ts: Date.now(), outcome: 'unknown' });
  saveState(path, state);
  return null;
}
