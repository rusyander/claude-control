// PreToolUse(Bash|PowerShell): a whole-project check of ONE kind mid-task → the narrow command instead.
//
// gate-at-end owns the full gate (a gate script or 2+ kinds). This is the larger cost it leaves: a lone
// `pnpm type-check`, `pnpm lint`, `eslint .`, `vitest run`, `pnpm test` after a small edit. A measured
// week: ~850 min of such runs (one project's lint 52× at 386 s, another's type-check 235× at 37 s); only
// 9 were plain repeats, the rest followed small edits. The narrow form keeps the semantics that matter mid-task: lint and tests of the touched files,
// incremental tsc (still the whole program, a fraction of the time). The final full gate is untouched.
// Allowed: a narrowed command (file args, `related`, `--changed`, `-t`, `--filter`), nothing touched in
// git, the user asking for the check or delivery this prompt, and a repeat of the identical call.
import { execFileSync } from 'node:child_process';
import { knownFor, loadStore } from './cmd-duration.mjs';
import { allNarrow, bareCommand, gateKinds, isFullGate } from './gate-at-end.mjs';
import {
  deny,
  ownTranscript,
  readTail,
  toolEvents,
  wasJustRefused,
  currentUserPrompt,
} from './transcript.mjs';

const ASKED =
  /(закоммит|коммить|\bcommit\b|запуш|\bpush\b|\bmr\b|\bмр\b|гейт|\bgate\b|финальн|сда[её]м|закрываем|(прогони|запусти|гони|проверь)\S*\s+(\S+\s+)?(тест|линт|тайпчек|тип|провер)|\blint\b|\btype-?check\b|\btsc\b|линт|тайпчек|все тесты|весь набор|full (suite|test))/i;
// A deny costs a model turn (~170k of context re-billed, several seconds) — more than a check it
// replaces when that check is quick: 45% of the flagged runs of a measured week finished under 20 s.
// So a type-check or test run is refused only once it is KNOWN to be slow here; a whole-project lint
// is refused on sight (its week median was 51 s).
const SLOW_S = 45;

// `node tests/x.test.mjs`, `node tools/qa/check-y.mjs` — one named script, narrow by construction (the
// word "test" in its path is what matched). A runner binary reached by path, or a script named after a
// whole-project check (`scripts/lint.mjs`, `run-tests.mjs`), still counts.
const NAMED_SCRIPT =
  /(?:^|[\s(])(?:node|tsx|bun|deno(?:\s+run)?)\s+(?:--\S+\s+)*([^\s-]\S*\.[cm]?[jt]s)\b/i;
const RUNNER_BIN =
  /(?:^|[\\/])(?:vitest|jest|eslint|tsc|mocha|lint|tests?|type-?check|run-tests|test-all)(?:\.[cm]?[jt]s)?$/i;
// A runner kept by its path is rewritten to its bare name: the kind reader drops every token with a
// slash (`…/project-tests/lint` is no lint), and the path itself would read as a narrowing argument.
const withoutNamedScripts = (command) =>
  bareCommand(command)
    .split(/&&|\|\||;|\n/)
    .flatMap((seg) => {
      const m = NAMED_SCRIPT.exec(seg);
      if (!m) return [seg];
      if (!RUNNER_BIN.test(m[1])) return [];
      const bare = m[1]
        .split(/[\\/]/)
        .pop()
        .replace(/\.[cm]?[jt]s$/i, '');
      return [seg.replace(m[1], bare)];
    })
    .join(' ; ');

const CHECK_KINDS = new Set(['types', 'lint', 'test']);

/**
 * The single check kind a whole-project command runs, else null. Judged per segment: the narrowing
 * must sit on the segment that runs the check, or `cd apps/server && npx vitest run` passes as narrow.
 */
export function wholeProjectCheck(command) {
  if (isFullGate(command)) return null; // gate-at-end's business
  const text = withoutNamedScripts(command);
  const kinds = new Set([...gateKinds(text)].filter((k) => CHECK_KINDS.has(k)));
  if (kinds.size !== 1) return null;
  return allNarrow(text) ? null : [...kinds][0];
}

/** Known quick here (learned median under SLOW_S), or not known and not a lint → let it run. */
function quickEnough(kind, cwd, command) {
  const known = knownFor(loadStore(), cwd, command);
  return known ? known.median < SLOW_S && known.kills === 0 : kind !== 'lint';
}

function touched(cwd) {
  try {
    const out = execFileSync('git', ['status', '--porcelain', '--untracked-files=normal'], {
      cwd,
      encoding: 'utf8',
      timeout: 3000,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return out
      .split('\n')
      .map((l) => l.slice(3).trim().replace(/^"|"$/g, ''))
      .filter((f) => f && !f.startsWith('.agent/') && !f.endsWith('/'))
      .map((f) => (f.includes(' -> ') ? f.split(' -> ')[1] : f));
  } catch {
    return null;
  }
}

const SOURCE = /\.(?:[cm]?[jt]sx?|vue|svelte)$/;
const EDIT_TOOLS = /^(?:Edit|Write|MultiEdit|NotebookEdit)$/;

/**
 * The dirty files this session edited; all dirty files when it edited none of them. Someone else's
 * uncommitted change in the tree is not this task's to check (porcelain paths are repo-relative, the
 * tool's are absolute — matched by suffix).
 */
export function ownTouched(files, events) {
  const edited = events
    .filter((e) => e.kind === 'use' && EDIT_TOOLS.test(String(e.name)))
    .map((e) => String(e.input?.file_path ?? e.input?.notebook_path ?? '').replace(/\\/g, '/'))
    .filter(Boolean);
  const own = files.filter((f) => edited.some((p) => p === f || p.endsWith(`/${f}`)));
  return own.length ? own : files;
}

// One incremental-tsc memory per config: two `-p` programs sharing a buildinfo overwrite each other.
function tsbuildinfoFor(command) {
  const p = /\s(?:-p|--project)\s+["']?([^\s"';&|]+)/.exec(bareCommand(command));
  const name = p
    ? p[1]
        .replace(/\\/g, '/')
        .split('/')
        .pop()
        .replace(/\.json$/i, '')
    : 'tsconfig';
  return `.agent/tmp/tsc-${name.replace(/[^\w.-]/g, '_')}.tsbuildinfo`;
}

export function narrowFor(kind, files, command = '') {
  const src = files.filter((f) => SOURCE.test(f)).slice(0, 12);
  const list = src.map((f) => `"${f}"`).join(' ');
  if (kind === 'lint')
    return src.length
      ? `npx eslint ${list}`
      : 'lint of the touched files only (none are JS/TS — likely nothing to lint)';
  if (kind === 'test')
    return src.length
      ? `npx vitest related ${list} --run (or the project runner on those files)`
      : 'the tests of the touched files only';
  return (
    `npx tsc --noEmit --incremental --tsBuildInfoFile ${tsbuildinfoFor(command)} (same program, warm after the ` +
    'first run; add -p <tsconfig> as the project script does) or the type-check of the one touched package ' +
    '(pnpm --filter <pkg> type-check)'
  );
}

export default function checkCost(input) {
  const tool = input?.tool_name;
  if (tool !== 'Bash' && tool !== 'PowerShell') return null;
  const command = String(input.tool_input?.command ?? '');
  const kind = wholeProjectCheck(command);
  if (!kind || quickEnough(kind, input.cwd, command)) return null;
  let records = [];
  let events = [];
  try {
    records = readTail(ownTranscript(input));
    events = toolEvents(records);
    if (wasJustRefused(events, tool, (o) => String(o?.command ?? '') === command)) return null;
  } catch {
    /* no transcript → judge the command alone */
  }
  if (ASKED.test(currentUserPrompt(input, records) ?? '')) return null;
  const dirty = touched(String(input.cwd ?? process.cwd()));
  if (!dirty || dirty.length === 0) return null;
  const files = ownTouched(dirty, events);
  return deny(
    `check-cost: a whole-project ${kind} run mid-task re-checks ${files.length > 40 ? 'the whole tree' : 'everything'} ` +
      `for ${files.length} touched file(s). Narrow: ${narrowFor(kind, files, command)}. The full gate runs once at the end ` +
      '(gate-at-end). Repeat this exact call if the whole project really is the point (a baseline, a config change).',
  );
}
