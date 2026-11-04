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
//   • shape: it runs with run_in_background and is never piped into tail/head/grep — a foreground
//     gate dies at the 600 s tool cap, a truncated one gets re-run just to read it, and only a
//     background gate can be stopped (TaskStop) when the task grows mid-run.
// Escape: repeat the identical call. Subagents are skipped — the hook sees the parent's transcript.
// State survives compaction in the kit state dir, gates/<session>.json.
// Kit hook item: run by the event dispatcher (lib/run.mjs) or on its own; see lib/items.mjs.
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import {
  backgroundParam,
  callKey,
  cliOf,
  sessionEvents,
  stateDir,
  sessionKey,
} from './kit-paths.mjs';
import {
  readTail,
  readTailText,
  toolEvents,
  resultFor,
  wasBlocked,
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
  /\b(npm|pnpm|yarn|bun)\s+(run\s+)?(gate|verify|ci|validate|check-all)\b|\bmake\s+(check|ci|verify|gate)\b/i;
// gate-run / check-ticket are gate runners named by their own file: a gate only as the command word —
// after env assignments, a wrapper and a script runner (`timeout 900 node <kit>/tools/gate-run.mjs …`).
// Matched anywhere in the segment, `K=/c/…/tools/gate-run.mjs` and `diff <(sed 's/\r$//' …/gate-run.mjs)
// <(…)` only NAMED the file and were denied as a full gate (watch 26.10 15:27). `--dry` prints a plan,
// `--help` the usage.
const RUNNER_GATE = /^(?:gate-run|check-ticket)(?:\.mjs)?$/i;
const RUNNER_QUIET = /^(?:--dry(?:-run)?|--help|-h)$/;
const HEREDOC = /<<-?\s*['"]?(\w+)['"]?[^\n]*\n[\s\S]*?\n\s*\1\b/g;
// `scripts/check_<x>.(mjs|py)` = a project's own gate script (`node scripts/check_all.mjs`,
// `python scripts/check_backend.py`): unrecognised, groups ran it once per stage on the same tree.
// Only the whole-side ones (F-35): `scripts/check_i18n.mjs` is one narrow check the project rules ask
// for, and denying it in a work stage left a group no way to run it; and only as the command itself —
// `eslint scripts/check_all.mjs` lints a file, it runs no gate. `<side>_tests` is a whole side too:
// a project's tests gate `check_frontend_tests.mjs` was 12 of the 27 full runs of group #1 (24.10),
// none of them seen.
const GATE_SCRIPT_NAMES = /^(?:(?:all|backend|frontend|full)(?:_tests)?|gate|ci|ticket)$/i;
const SCRIPT_RUNNER = /^(?:node|python3?|py|bun|tsx|deno|uv|poetry|pipenv|run)$/i;

// A wrapper in front of the runner and its own arguments: `timeout 900 node scripts/check_x.mjs` is the
// same gate (g9 review F5, 26.10: a reworded gate call must not be a new gate, nor no gate at all).
const GATE_WRAPPER = /^(?:timeout|time|nice|nohup|env|stdbuf)$/i;
const WRAPPER_ARG = /^(?:-\S*|\d+(?:\.\d+)?[smhd]?)$/i;
const GATE_SCRIPT_PATH =
  /^(?:\.{0,2}[\\/])?(?:[\w.@-]+[\\/])*scripts[\\/]check_([\w-]+)\.(?:mjs|py)$/i;

/**
 * The gate script a segment runs as its own command — `[env=…] [timeout N] [runner] [./]…scripts/
 * check_<whole-side>.(mjs|py) [args]` — as `{ script, args }`, or null.
 */
function gateScriptOf(seg) {
  const words = seg
    .replace(/^\s*(?:do|then|else)\s+/, '')
    .trim()
    .split(/\s+/);
  const at = commandAt(words);
  const m = GATE_SCRIPT_PATH.exec(words[at] ?? '');
  if (!m || !GATE_SCRIPT_NAMES.test(m[1])) return null;
  return { script: words[at], args: words.slice(at + 1).join(' ') };
}
/** Index of the file a segment runs: past env assignments, wrappers with their arguments, a script runner. */
function commandAt(words) {
  let at = 0;
  for (;;) {
    const from = at;
    while (/^(?:\w+=.*|do|then|else|!)$/s.test(words[at] ?? '')) at += 1;
    if (GATE_WRAPPER.test(words[at] ?? '')) {
      at += 1;
      while (WRAPPER_ARG.test(words[at] ?? '')) at += 1;
    }
    if (at === from) break;
  }
  while (at < words.length && (SCRIPT_RUNNER.test(words[at]) || /^-/.test(words[at]))) at += 1;
  return at;
}
/**
 * Shell segments with quotes respected (heredoc bodies dropped; `(`/`)` split too, so a process or
 * command substitution is a segment of its own), each as unquoted words.
 */
function quotedSegments(command) {
  const s = String(command).replace(HEREDOC, ' ');
  const out = [];
  let cur = '';
  let quote = null;
  for (const c of s) {
    if (quote) {
      if (c === quote) quote = null;
    } else if (c === '"' || c === "'") quote = c;
    else if (';&|\n()'.includes(c)) {
      out.push(cur);
      cur = '';
      continue;
    }
    cur += c;
  }
  out.push(cur);
  return out.map((seg) =>
    (seg.match(/"[^"]*"|'[^']*'|\S+/g) ?? []).map((w) =>
      w.replace(/^"(.*)"$/s, '$1').replace(/^'(.*)'$/s, '$1'),
    ),
  );
}
/** `node --check <file>` / `-c` (bun too) only parses the file — a syntax check, not a run (26.10). */
const parseOnly = (before) =>
  before.some((w) => /^(?:node|bun)(?:\.exe)?$/i.test(w)) &&
  before.some((w) => /^(?:--check|-c)$/.test(w));
/** The command runs gate-run / check-ticket as a command word (a `$VAR` assigned in it resolved). */
export function runsGateRunner(command) {
  const segs = quotedSegments(command);
  const vars = new Map();
  for (const words of segs)
    for (const w of words) {
      const m = /^(\w+)=(.*)$/s.exec(w);
      if (!m) break;
      vars.set(m[1], m[2]);
    }
  return segs.some((words) => {
    const at = commandAt(words);
    const ref = /^\$\{?(\w+)\}?$/.exec(words[at] ?? '');
    const file = ref ? (vars.get(ref[1]) ?? '') : (words[at] ?? '');
    if (!RUNNER_GATE.test(file.split(/[\\/]/).pop() ?? '')) return false;
    if (parseOnly(words.slice(0, at))) return false;
    return !words.slice(at + 1).some((w) => RUNNER_QUIET.test(w));
  });
}
/** The segment runs `[runner] [./]…scripts/check_<whole-side>.(mjs|py)` as its own command. */
function projectGateScript(seg) {
  return gateScriptOf(seg) !== null;
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
 * `.agent/` holds the agent's working notes (progress, notebook), outside git: an edit there is no fix to
 * the code. g8 26.10: the only edit after a refused gate was `.agent/run/notebook.agent.md`, and the
 * delivery stage denied the re-run as «red, code edited since».
 */
const NOTE_PATH = /(?:^|[\\/])\.agent[\\/]/;
const codeEdit = (tool, path) =>
  EDIT_TOOL.test(String(tool)) && !NOTE_PATH.test(String(path ?? ''));
/** A transcript tool_use event that edits code (not a working note). */
const editsCode = (e) =>
  e.kind === 'use' && codeEdit(e.name, e.input?.file_path ?? e.input?.notebook_path);

/**
 * The command without the text it only carries: heredoc bodies and quoted strings. A gate quoted inside
 * an `echo '{…"pnpm lint && pnpm test"…}' | node hook.mjs` probe is data, not a run.
 */
export function bareCommand(command) {
  return (
    String(command)
      .replace(HEREDOC, ' ')
      // A quoted gate-script path right after its runner is the run itself, not data (g9 review F5).
      .replace(QUOTED_GATE_SCRIPT, '$1$3')
      .replace(/'[^']*'|"(?:\\.|[^"\\])*"/g, ' ')
  );
}
const QUOTED_GATE_SCRIPT =
  /(\b(?:node|python3?|py|bun|tsx|deno)\s+)(["'])((?:[^"'\s]*[\\/])?scripts[\\/]check_[\w-]+\.(?:mjs|py))\2/gi;

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
  // The gate runner is named by its path, often quoted — judged on the raw command, as its command word.
  if (runsGateRunner(command)) kinds.add('gate');
  for (const seg of bareCommand(command).split(/&&|\|\||;|\n/)) {
    const s = checkText(seg);
    if (!s || NOT_CHECK.test(s)) continue;
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
// A top-level package of a monorepo has no slash (`cd inst-admin-ui && npm run type-check`, g5 25.10:
// denied as whole while the deny text recommends exactly that); `cd ..` / `cd ~` / `cd -` stay whole.
const PACKAGE_CD =
  /(?:^|&&|;)\s*cd\s+["']?(?:[\w.@~-]+[\\/][^\s;&]*|(?![.~-])[\w@-][\w.@-]*(?=["']?\s*(?:&&|;|$)))/;
const CD_TARGET = /(?:^|&&|;|\n)\s*cd\s+(?:"([^"]+)"|'([^']+)'|([^\s;&|]+))/g;

/** One spelling of a Windows/POSIX path: `/c/x`, `C:\x`, `c:/x/` → `c:/x`. */
const pathForm = (p) =>
  String(p)
    .replace(/\\/g, '/')
    .replace(/^\/([a-z])(?=\/|$)/i, '$1:')
    .replace(/\/+$/, '')
    .toLowerCase();

/**
 * An absolute `cd` into a strict subfolder of the session cwd is a package cd too (g9 25.10:
 * `cd C:/…/feat-PROJ-55/inst-admin-ui && npx tsc -p tsconfig.app.json` from the copy root was denied as
 * a whole gate). The copy root itself, or a folder outside it, stays whole.
 */
function absolutePackageCd(command, cwd) {
  if (!cwd) return false;
  const root = pathForm(cwd);
  for (const m of String(command).matchAll(CD_TARGET)) {
    const target = m[1] ?? m[2] ?? m[3] ?? '';
    if (!/^(?:[a-z]:[\\/]|\/)/i.test(target)) continue;
    if (pathForm(target).startsWith(`${root}/`)) return true;
  }
  return false;
}

/**
 * A package-manager flag naming one package (g9 25.10: `npm --prefix inst-admin-ui run type-check` beside a
 * narrow test run was denied as a whole gate — the same check `cd inst-admin-ui && npm run type-check` passes):
 * `--prefix`, `--dir`, `--cwd`, `--workspace`, `-C`, `-w`. `.`/`..` stay whole; an absolute path counts only
 * strictly inside the session cwd, as an absolute `cd` does.
 */
function packageFlag(seg, cwd) {
  const re = /\s(?:--prefix|--dir|--cwd|--workspace|-C|-w)(?:=|\s+)["']?([^\s"';&|]+)/g;
  for (const m of String(seg).matchAll(re)) {
    const dir = m[1].replace(/[\\/]+$/, '');
    if (!dir || /^\.{1,2}$/.test(dir) || /^-/.test(dir)) continue;
    if (!/^(?:[a-z]:[\\/]|[\\/])/i.test(dir)) return true;
    if (cwd && pathForm(dir).startsWith(`${pathForm(cwd)}/`)) return true;
  }
  return false;
}

/** Shell redirects of a segment (`> ../.agent/run.log 2>&1`): a log path is no test target. */
const REDIRECT = /\s*(?:\d?>{1,2}|&>)\s*(?:&\d|[^\s;&|]+)/g;

const MANIFESTS = ['package.json', 'pyproject.toml', 'go.mod', 'Cargo.toml'];

/**
 * The shell already stands in one package (g8 26.10 #g8:115: shell in `<copy>/inst-docs-ui`, `npm run type-check`
 * with no `cd` was denied as whole — the narrow form the deny text names). A folder with its own manifest strictly
 * below the repository root (the nearest `.git` above it); a command with any `cd` is judged by its `cd`.
 */
function shellInPackage(command, cwd) {
  if (!cwd || /(?:^|&&|;|\||\n)\s*(?:cd|pushd)\s/.test(command)) return false;
  const here = resolve(String(cwd));
  if (!MANIFESTS.some((m) => existsSync(join(here, m))) || existsSync(join(here, '.git')))
    return false;
  for (let d = dirname(here); d !== dirname(d); d = dirname(d))
    if (existsSync(join(d, '.git'))) return true;
  return false;
}

/** Every check segment of the command already runs narrow (file args, a filter, one package). */
export function allNarrow(command, cwd) {
  const bare = bareCommand(command);
  const checks = bare
    .split(/&&|\|\||;|\n/)
    .map((seg) => ({ seg, kinds: [...gateKinds(seg)] }))
    .filter((c) => c.kinds.length > 0);
  if (!checks.length) return false;
  const inPackage =
    PACKAGE_CD.test(bare) || absolutePackageCd(command, cwd) || shellInPackage(bare, cwd);
  // A build of one package (`cd shared-ui && npm run build`, g9 25.10) is as narrow as its type-check.
  const perPackage = (k) => k === 'types' || k === 'build';
  return checks.every(({ seg, kinds }) => {
    if (kinds.some((k) => !['types', 'lint', 'test', 'build'].includes(k))) return false;
    // `node scripts/lint.mjs` — the script's own path is the command, not a file argument; a redirect
    // target is a log, not a target (`npx vitest run > ../.agent/all.log` read as narrow, g9 25.10).
    const s = seg.replace(REDIRECT, ' ').replace(/\b(node|tsx|bun|deno(?:\s+run)?)\s+\S+/gi, '$1');
    return kinds.every((k) =>
      perPackage(k)
        ? inPackage || TYPES_NARROW.test(s) || packageFlag(s, cwd)
        : NARROW.test(s) && !WHOLE_DIR.test(s),
    );
  });
}

/**
 * Full gate = a gate script, or two or more check kinds of which at least one runs whole. A pair of
 * narrow checks (`vitest run a.test.ts && eslint a.ts`) is exactly what the follow-up texts recommend;
 * counted as a gate it was denied in the foreground and then as "already ran" (54 a week, p50 18 s).
 */
export function isFullGate(command, cwd) {
  const kinds = gateKinds(command);
  return kinds.has('gate') || (kinds.size >= 2 && !allNarrow(command, cwd));
}

const RUNNER_CONFIG = /^(?:vitest|vite|jest)\.(?:config|workspace)\.[cm]?[jt]s$/;

/**
 * `npm --prefix <pkg> exec -- vitest …` / `npx --prefix <pkg> vitest …`: npm exec and npx take --prefix only to
 * find the binary and start it in the shell's folder, so the package's runner config, setup files and aliases
 * are not loaded (g9 25.10: «suites fail to load», twice, even with `--root <pkg>`). `{ pkg, runner }` when
 * `<pkg>` holds a vitest/vite/jest config of its own, else null. `npm --prefix <pkg> run <script>` runs in
 * `<pkg>` and is fine.
 */
export function prefixRunner(command, cwd) {
  for (const seg of bareCommand(command).split(/&&|\|\||;|\n|\|/)) {
    const words = seg.trim().split(/\s+/);
    let at = 0;
    while (/^\w+=/.test(words[at] ?? '')) at += 1;
    const head = String(words[at] ?? '').replace(/\.cmd$/i, '');
    if (!/^(?:npm|npx)$/i.test(head)) continue;
    let pkg = null;
    let exec = /^npx$/i.test(head);
    let runner = null;
    for (let i = at + 1; i < words.length; i += 1) {
      const w = words[i];
      const p = /^--prefix(?:=(.*))?$/.exec(w);
      if (p) {
        pkg = p[1] ?? words[(i += 1)] ?? null;
        continue;
      }
      if (!exec && /^(?:exec|x)$/.test(w)) exec = true;
      else if (!exec && !/^-/.test(w)) break;
      else if (exec && /^(?:vitest|jest)$/i.test(w)) {
        runner = w.toLowerCase();
        break;
      }
    }
    if (!pkg || !runner || /^\.\.?[\\/]?$/.test(pkg)) continue;
    const base = String(commandCwd(command, cwd) ?? cwd ?? process.cwd());
    const dir = isAbsolute(pkg) ? pkg : join(base, pkg);
    let files;
    try {
      files = readdirSync(dir);
    } catch {
      continue;
    }
    if (files.some((f) => RUNNER_CONFIG.test(f))) return { pkg, runner };
  }
  return null;
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

const isGateRun = (command, cwd) =>
  isFullGate(command, cwd) || isFullGate(scriptText(command, cwd), cwd);

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

/** The harness's text for a call it never saw finish (session ended, user interrupt). */
const INTERRUPTED = /^\s*\[?(?:Tool call interrupted\b|Request interrupted by user\b)/;

/**
 * Which gate a run is, inside one session: the `cd` it runs under plus its gate segments only, each
 * without redirects and its pipeline tail. A sibling gate (`check_frontend_tests` after `check_frontend`)
 * is a first run, not a re-run (g5 25.10: denied «nothing was edited since the full gate» three times),
 * while another `tail`/`grep` of the same log keeps the same gate. A gate behind a script file has no
 * gate segment of its own — then the whole command, as gateKey keys it.
 */
export function runKey(command, cwd = '') {
  const bare = bareCommand(command);
  const cd = /^\s*cd\s+(?:"([^"]+)"|'([^']+)'|([^\s;&|]+))\s*(?:;|&&)/.exec(String(command));
  const raw = cd?.[1] ?? cd?.[2] ?? cd?.[3] ?? '';
  // `cd <the session cwd> && …` stands where the call already stood (g9 review F5).
  const dir = cwd && raw && pathForm(raw) === pathForm(cwd) ? '' : pathForm(raw);
  const segs = bare
    .split(/&&|\|\||;|\n/)
    .filter((seg) => isFullGate(seg) || gateKinds(seg).size > 0)
    .map((seg) => gateKey(seg.replace(/\|[\s\S]*$/, '')))
    .filter(Boolean);
  // A gate script is keyed by the file it runs plus its arguments, not by how the line spells it: env
  // prefixes, `timeout`, `./`, quotes, a `cd sub && node ../scripts/…` (g9 review F5, 26.10: a re-worded
  // call was a new gate). Resolved against cwd when the caller knows it.
  const scripts = segs.map((seg) => {
    const gs = gateScriptOf(seg);
    if (!gs) return null;
    const file = cwd
      ? pathForm(resolve(String(cwd), raw || '.', gs.script))
      : pathForm(join(raw || '.', gs.script));
    return `script:${file}${gs.args ? ` ${gs.args}` : ''}`;
  });
  if (segs.length && scripts.every(Boolean)) return `::${scripts.join(' && ')}`;
  const gates = segs.map((seg, i) => scripts[i] ?? seg);
  return `${dir}::${gates.length ? gates.join(' && ') : gateKey(command)}`;
}

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Labels a command prints its gate's own exit code under: `echo fe=$?`, `echo "rc: $?"`,
 * `rc=$?; … echo "rc=$rc"`. The call's exit is its last command's (`tail`), so `fe=1` printed by a
 * green call read green and the re-run on the right Node was denied as «nothing edited» (g0 26.10).
 */
function exitLabels(command) {
  const text = String(command);
  const vars = [...text.matchAll(/\b([A-Za-z_]\w*)=\$\?/g)].map((m) => m[1]);
  const ref = ['\\$\\?', ...vars.map((v) => `\\$\\{?${v}\\}?(?!\\w)`)].join('|');
  const labels = new Set();
  for (const seg of text.split(/[;&|\n]+/)) {
    if (!/^\s*(?:\(\s*)?(?:echo|printf)\b/.test(seg)) continue;
    for (const m of seg.matchAll(new RegExp(`([^\\s"'$]+)\\s?(?:${ref})`, 'g')))
      if (/[A-Za-z]/.test(m[1])) labels.add(m[1]);
  }
  return [...labels];
}

/** Each label's LAST printed code (an appended log holds older runs above it); any non-zero is red. */
function capturedExitRed(command, body) {
  return exitLabels(command).some((label) => {
    const codes = [...body.matchAll(new RegExp(`(?<![\\w-])${escapeRe(label)}\\s*(\\d+)\\b`, 'g'))];
    return codes.length > 0 && Number(codes[codes.length - 1][1]) !== 0;
  });
}

function looksRed(res, command = '') {
  if (res.isError) return true;
  const body = res.body || '';
  if (capturedExitRed(command, body)) return true;
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
  return looksRed({ isError: false, body: logTails(command, cwd, output) }, command)
    ? 'red'
    : 'green';
}

/**
 * Tails of the run's own output: the task output file and every redirect target. With `> cases.log …
 * > gate.log` only the first was read and a red gate whose verdict sat in the second read green (18.10).
 */
function logTails(command, cwd, output) {
  const logs = [
    ...command.matchAll(/(?:^|\s)\d?>{1,2}\s*["']?([^\s"'&|;]+\.(?:log|txt|out))/g),
  ].map((m) => m[1]);
  return [output, ...new Set(logs)]
    .filter(Boolean)
    .map((f) => tailOf(f, commandCwd(command, cwd)))
    .join('\n');
}

/**
 * Hard refusals of the Node engine, not warnings: strict npm / pnpm / yarn, and a project's own pre-check
 * («Гейт рассчитан на Node 22…, запущен на v24»). `npm WARN EBADENGINE` lets the run go on and stays out.
 */
const ENGINE_REFUSAL =
  /npm (?:error|ERR!) code EBADENGINE|ERR_PNPM_UNSUPPORTED_ENGINE|The engine "node" is incompatible|рассчитан на Node[^\n]{0,80}запущен на/i;

/**
 * The run stopped at the engine check before any check ran: no verdict on the code, so it is no gate run.
 * g8 26.10: such a run read red, and the re-run on the right Node was denied as «red, edited since».
 */
function engineRefused(command, body, rawTail, cwd) {
  if (ENGINE_REFUSAL.test(body)) return true;
  const taskId = /running in background with ID:\s*(\w+)/i.exec(body)?.[1];
  const at = taskId ? rawTail.lastIndexOf(`<task-id>${taskId}</task-id>`) : -1;
  const note = at < 0 ? '' : rawTail.slice(at, at + 1500);
  const output = /<output-file>([^<]+)<\/output-file>/.exec(note)?.[1]?.trim();
  return ENGINE_REFUSAL.test(logTails(command, cwd, output));
}

/**
 * Every string of a post-hook input except the call's own input: the result body under whichever key this
 * CLI sends it (`tool_response` of Claude/Qwen/Codex/OpenCode, Gemini's `{llmContent, returnDisplay}`, Kimi's
 * and Goose's own fields) — read whole, so no dialect needs its own reader.
 */
function resultText(input) {
  const out = [];
  const walk = (value, depth) => {
    if (out.length >= 200 || depth > 6) return;
    if (typeof value === 'string') out.push(value);
    else if (Array.isArray(value)) value.forEach((v) => walk(v, depth + 1));
    else if (value && typeof value === 'object')
      for (const [key, v] of Object.entries(value)) if (key !== 'tool_input') walk(v, depth + 1);
  };
  walk(input, 0);
  return out.join('\n');
}

/** Redirect targets of a command, absolute — a foreign run's state keeps them to re-read its log later. */
function logFiles(command, cwd) {
  const dir = commandCwd(command, cwd) ?? process.cwd();
  return [
    ...new Set(
      [...command.matchAll(/(?:^|\s)\d?>{1,2}\s*["']?([^\s"'&|;]+\.(?:log|txt|out))/g)].map((m) =>
        isAbsolute(m[1]) ? m[1] : join(String(dir), m[1]),
      ),
    ),
  ];
}

/**
 * Post hook of a CLI whose transcript the kit cannot read (P-31): did the engine check stop this gate run
 * before any check ran? The result body and the redirected logs are all the kit sees of it; the `ran` it
 * logs carries the answer, and that run then decides nothing — exactly as `previousGates` drops it for
 * Claude. A background start has no verdict in its body yet: its logs are read again at the next gate.
 */
export function engineRefusedCall(call) {
  const command = withoutReason(String(call?.tool_input?.command ?? ''));
  if (!command || !isGateRun(command, call?.cwd)) return false;
  return ENGINE_REFUSAL.test(resultText(call)) || ENGINE_REFUSAL.test(logTails(command, call?.cwd));
}

/** A foreign run the engine check stopped: its `ran` said so, or its logs say so now (background). */
function engineStopped(run, log) {
  if (
    log.some(
      (e) => e.kind === 'ran' && e.engine && e.key === run.key && Number(e.ts) >= Number(run.ts),
    )
  )
    return true;
  const logs = Array.isArray(run.logs) ? run.logs : [];
  return logs.length > 0 && ENGINE_REFUSAL.test(logs.map((f) => tailOf(f, '')).join('\n'));
}

/**
 * Previous full gates, newest last: from the transcript tail, merged with the saved state. `refused`
 * collects the ids the engine check stopped — the caller drops them from the saved state too.
 */
function previousGates(events, rawTail, state, cwd, refused = new Set()) {
  const seen = new Map(state.runs.map((r) => [r.id, { ...r, index: -1 }]));
  events.forEach((e, i) => {
    if (
      e.kind !== 'use' ||
      !/^(Bash|PowerShell)$/.test(String(e.name)) ||
      !isGateRun(e.input?.command ?? '', cwd)
    )
      return;
    const res = resultFor(events.slice(i), e.id);
    if (!res) {
      // No result while a later call already has one: the session ended under this run — no verdict,
      // and the entry saved when it was let through goes too. Otherwise it is still running.
      if (events.slice(i + 1).some((x) => x.kind === 'result')) seen.delete(e.id);
      return;
    }
    // Blocked by any hook or the classifier = never ran; the entry saved when this guard let it through goes too.
    if (wasBlocked(res.body)) return void seen.delete(e.id);
    // Cut by a session end or the user's interrupt: no exit status, a partial log — neither green nor red
    // (g5 25.10: an 11-min gate killed at 19:01 read red, its re-run after the resume denied).
    if (INTERRUPTED.test(res.body)) return void seen.delete(e.id);
    if (engineRefused(e.input?.command ?? '', res.body, rawTail, cwd)) {
      refused.add(e.id);
      return void seen.delete(e.id);
    }
    let outcome = looksRed(res, e.input?.command ?? '') ? 'red' : 'green';
    const bg = /running in background with ID:\s*(\w+)/i.exec(res.body);
    if (bg) outcome = backgroundOutcome(rawTail, bg[1], e.input?.command ?? '', cwd) ?? 'running';
    const taskId = bg?.[1] ?? null;
    const ts = e.ts ?? Date.now();
    // A saved entry without the tool_use_id (older CLI) is the same run seconds later — drop it.
    for (const [id, r] of seen) if (r.index < 0 && Math.abs(r.ts - ts) < 15_000) seen.delete(id);
    seen.set(e.id, {
      id: e.id,
      ts,
      outcome,
      index: i,
      taskId,
      cmd: runKey(e.input?.command ?? '', cwd),
    });
  });
  return [...seen.values()].filter((r) => r.outcome !== 'stopped').sort((a, b) => a.ts - b.ts);
}

function editsAfter(events, index) {
  // A run older than the tail (known only from state): every edit in the tail came after it.
  const from = index < 0 ? 0 : index + 1;
  return events.slice(from).filter(editsCode).length;
}

/**
 * Not Claude: the kit cannot read the CLI's transcript (Qwen, Codex, Gemini, OpenCode keep their own
 * format, Goose and Kimi send none), so the gate history comes from the kit's session log (P-20). A run
 * saved at PreToolUse counts only once a `ran` of the same call followed: the post hook writes it, and a
 * post hook fires only for a call that executed. A user reject, the CLI's own rules, another hook — no
 * `ran`, no run. Read as a run, the blocked gate refused the next one as "nothing was edited since".
 * A CLI with no post hook on its shell remembers no gate at all — the lenient side.
 */
function foreignLog(input) {
  return cliOf(input) === 'claude' ? null : sessionEvents(input);
}

function ranRuns(runs, log) {
  return runs.filter(
    (r) =>
      r.key && log.some((e) => e.kind === 'ran' && e.key === r.key && Number(e.ts) >= Number(r.ts)),
  );
}

/** Edits the kit let through after `ts`, from the session log (there is no transcript to count them in). */
function loggedEditsAfter(log, ts) {
  return log.filter(
    (e) => e.kind === 'call' && codeEdit(e.tool, e.file) && Number(e.ts) > Number(ts),
  ).length;
}

/** Full gates of this session, oldest first — for the prompt hint. [] on any read failure. */
export function sessionGates(input) {
  try {
    const raw = readTailText(input?.transcript_path, 4_000_000);
    const state = loadState(statePath(input));
    const log = foreignLog(input);
    if (log)
      state.runs = ranRuns(
        state.runs.filter((r) => !engineStopped(r, log)),
        log,
      );
    return previousGates(toolEvents(readTail(input.transcript_path)), raw, state, input?.cwd);
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

// A trailing `# gate-reason: …` comment is no part of the gate (it was the escape of the panel groups'
// delivery stage, and models still write it): every kind and key is read without it.
const GATE_REASON = /[ \t]*#[ \t]*gate-reason:[ \t]*([^\n]*)/;
export const withoutReason = (command) => String(command).replace(new RegExp(GATE_REASON, 'g'), '');

/** A gate segment as runKey keys it (F-36): the command, without a `cd` in front or its logs. */
export function gateKey(command) {
  return String(command)
    .replace(/^\s*cd\s+(?:"[^"]*"|'[^']*'|[^\s;&|]+)\s*(?:;|&&)/, '')
    .replace(/\s+(?:\d?>{1,2}|&>)\s*(?:&\d|"[^"]*"|'[^']*'|[^\s;&|]+)/g, ' ')
    .replace(/;\s*echo\b[^;&|]*$/, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** The identical command was the last refused call of this tool: the repeat escape. False on any read failure. */
function repeatOfRefused(input, command) {
  const key = String(command).replace(/\s+/g, ' ').trim();
  try {
    return wasJustRefused(
      toolEvents(readTail(input.transcript_path)),
      input.tool_name,
      (other) =>
        String(other?.command ?? '')
          .replace(/\s+/g, ' ')
          .trim() === key,
    );
  } catch {
    return false;
  }
}

export default function gateAtEnd(input) {
  const tool = input?.tool_name;
  if (tool !== 'Bash' && tool !== 'PowerShell') return null;
  if (inSubagent(input)) return null;
  const typed = String(input.tool_input?.command ?? '');
  // The reason comment is no part of the gate: every key and kind below is read without it.
  const command = withoutReason(typed);
  // A test runner started outside its package: refused with the form that runs (escapable by a repeat —
  // the shell may already stand in the package).
  const misplaced = prefixRunner(command, input.cwd);
  if (misplaced && !repeatOfRefused(input, command)) {
    const { pkg, runner } = misplaced;
    const form = runner === 'jest' ? 'npx jest <files>' : 'npx vitest run <files>';
    return deny(
      `gate-at-end: npm exec / npx take --prefix only to find ${runner}; it still starts in the shell's folder, ` +
        `not in ${pkg}, so ${pkg}'s ${runner} config, setup files and aliases are not loaded — the suites fail to ` +
        `load or a different set runs, and the run is repeated. Run it inside the package, paths relative to it: ` +
        `\`cd ${pkg} && ${form}\` (or \`npm --prefix ${pkg} run <test script> -- <files>\`, which does run in ` +
        `${pkg}). Repeat this exact call only if the shell already stands in ${pkg}.`,
    );
  }

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
  const flat = (text) =>
    String(text ?? '')
      .replace(/\s+/g, ' ')
      .trim();
  if (wasJustRefused(events, tool, (other) => flat(other?.command) === flat(typed))) return null;
  const again = (when) => `Repeat this exact call ${when}.`;

  // Foreground stays the rule where background is not wanted: a local-model run (local-discipline
  // refuses background shells). A CLI whose shell has no background flag (Codex) keeps the foreground
  // too — nothing to obey.
  const bgParam = backgroundParam(input);
  const foreground = (process.env.AGENTDECK_KIT_VARIANT ?? '').trim() === 'local' || !bgParam;
  const bg = input.tool_input?.run_in_background === true;
  if (!foreground && (!bg || TRUNCATED.test(command))) {
    return deny(
      `gate-at-end: a full gate runs with ${bgParam}:true and its whole output (no | tail/head/grep; ` +
        'for a log file add `> .agent/tmp/gate.log 2>&1`). A foreground gate dies at the 600 s tool cap, a truncated ' +
        'one gets re-run just to be read, and only a background gate can be stopped (TaskStop) if the task grows ' +
        'while it runs. After starting it: do the remaining non-code work or end the turn saying the gate is running; ' +
        'the completion notification wakes you — never sleep-poll. Repeat this exact call only if it must stay as is.',
    );
  }

  const id = String(input.tool_use_id ?? `t${Date.now()}`);
  const path = statePath(input);
  const state = loadState(path);
  const log = foreignLog(input);
  // Not Claude: a run the engine check stopped never ran a check (P-31) — it leaves the state, as the
  // engine-refused ids below do for Claude.
  const stopped = log ? state.runs.filter((r) => engineStopped(r, log)) : [];
  if (stopped.length) state.runs = state.runs.filter((r) => !stopped.includes(r));
  // Not Claude: only runs confirmed by `ran` decide; unconfirmed ones stay in the state (a day at most) —
  // the `ran` of a long foreground gate may come after this call.
  const pending = log
    ? state.runs.filter((r) => !ranRuns([r], log).length && Date.now() - Number(r.ts) < 864e5)
    : [];
  if (log) state.runs = ranRuns(state.runs, log);
  const keep = () => ({ ...state, runs: [...pending, ...state.runs].sort((a, b) => a.ts - b.ts) });
  const refused = new Set();
  const runs = previousGates(events, raw, state, input.cwd, refused);
  // Outcomes learned from the tail go back into the state: a red gate saved as 'unknown' read as green
  // once its run scrolled out of the tail. A blocked one leaves the state: out of the tail it read as a run.
  // So does one the engine check refused: it never ran a check.
  const blocked = new Set([
    ...events.filter((e) => e.kind === 'result' && wasBlocked(e.body)).map((e) => e.id),
    ...refused,
  ]);
  const kept = state.runs.filter((r) => !blocked.has(r.id));
  let learnedOutcome = kept.length !== state.runs.length || stopped.length > 0;
  state.runs = kept;
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
  if (learnedOutcome) saveState(path, keep());
  const last = runs[runs.length - 1];
  // "Already ran" is about THIS gate (F-36 in the session too): the last run with the same runKey. An
  // entry saved before runs were keyed names no gate and counts for none.
  const thisGate = runKey(command, input.cwd);
  const prev = runs.findLast((r) => r.cmd === thisGate);
  const prompt = String(currentUserPrompt(input, records) ?? '');

  if (last?.outcome === 'running') {
    return deny(
      `gate-at-end: a full gate started at ${hhmm(last.ts)} is still running in the background. Wait for its ` +
        'notification. If the task grew since it started, stop it (TaskStop), finish the new work, then run the full ' +
        'gate once.',
    );
  }
  if (prev) {
    const edits = log ? loggedEditsAfter(log, prev.ts) : editsAfter(events, prev.index);
    if (edits === 0) {
      return deny(
        `gate-at-end: nothing was edited since the full gate at ${hhmm(prev.ts)} (${prev.outcome}). Its output is ` +
          `already there — read it (the task output file or the log) instead of re-running. ${again('only for a suspected flaky run')}`,
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
  // Not Claude: the call's key — the post hook's `ran` under it confirms the gate really executed — and
  // its logs, where a background run's engine refusal lands after the post hook has fired (P-31).
  const logs = log ? logFiles(command, input.cwd) : [];
  state.runs.push({
    id,
    ts: Date.now(),
    outcome: 'unknown',
    cmd: thisGate,
    ...(log ? { key: callKey(input) } : {}),
    ...(logs.length ? { logs } : {}),
  });
  saveState(path, keep());
  return null;
}
