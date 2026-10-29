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
// Escape: repeat the identical call; in a group's delivery stage, the call plus `# gate-reason: <why>`
// (see GATE_REASON). Subagents are skipped — the hook sees the parent's transcript.
// State survives compaction in the kit state dir, gates/<session>.json.
// Kit hook item: run by the event dispatcher (lib/run.mjs) or on its own; see lib/items.mjs.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  copyFileSync,
  existsSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
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

/**
 * The first segment that runs a test suite whole — no test file, folder or filter (`npm --prefix pkg run
 * test:ci -- src`, `cd pkg && npx vitest run`, `pytest`, `go test ./...`), or null. One package's whole
 * suite is still whole: g9 25.10 ran 857 files / 350 s of it in the work stage, after the gate itself was
 * denied, as the gate's test half rebuilt by hand.
 */
export function wholeSuiteRun(command) {
  for (const seg of bareCommand(command).split(/&&|\|\||;|\n/)) {
    const text = checkText(seg);
    if (!text || NOT_CHECK.test(text) || !gateKinds(seg).has('test')) continue;
    const s = seg.replace(REDIRECT, ' ').replace(/\b(node|tsx|bun|deno(?:\s+run)?)\s+\S+/gi, '$1');
    if (NARROW.test(s) && !WHOLE_DIR.test(s) && !/\s\.\/\.\.\.(?:\s|$)/.test(s)) continue;
    return seg.replace(REDIRECT, ' ').replace(/\s+/g, ' ').trim();
  }
  return null;
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
 * gate segment of its own — then the whole command, as the ledger keys it.
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

/**
 * A narrow check (check kinds, no full gate) passed after the last edit that follows event `from`.
 * Delivery stage of group #1 (24.10): red full gate → fix → full gate → fix, 7 full runs in 10 min
 * (843 s) where one red lint or one red test file needed a 5–40 s re-run of its own.
 */
function narrowGreenAfter(events, rawTail, from, cwd) {
  let lastEdit = -1;
  for (let i = Math.max(from + 1, 0); i < events.length; i += 1)
    if (editsCode(events[i])) lastEdit = i;
  for (let i = lastEdit + 1; i < events.length; i += 1) {
    const e = events[i];
    if (e.kind !== 'use' || !/^(Bash|PowerShell)$/.test(String(e.name))) continue;
    const command = String(e.input?.command ?? '');
    if (gateKinds(command).size === 0 || isGateRun(command, cwd)) continue;
    const res = resultFor(events.slice(i), e.id);
    if (!res || wasBlocked(res.body)) continue;
    const bg = /running in background with ID:\s*(\w+)/i.exec(res.body);
    const outcome = bg
      ? backgroundOutcome(rawTail, bg[1], command, cwd)
      : looksRed(res, command)
        ? 'red'
        : 'green';
    if (outcome === 'green') return true;
  }
  return false;
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

// Panel split group (owner 23.10): ONE full gate per group, in its delivery stage. Every stage is a new
// session, so "the first full gate of the session is free" restarted at each stage: the 23.10 day ran
// full gates 113× in work stages, 22× in review, 36× in fix against 33× in delivery — often on one tree.
// The panel names the stage (AGENTDECK_GROUP_STAGE) and whether a delivery stage follows
// (AGENTDECK_GROUP_DELIVER_AHEAD=1); a per-copy ledger keyed by the working tree spans the stages.
const groupStage = () => String(process.env.AGENTDECK_GROUP_STAGE ?? '').trim();
const deliverAhead = () => process.env.AGENTDECK_GROUP_DELIVER_AHEAD === '1';
const groupSession = () => Boolean(groupStage() || process.env.AGENTDECK_HEAVY_QUEUE_DIR);

// Delivery stage escape (g9 26.10, F3): a bare repeat lifted every refusal there, and the stage ran
// check_frontend 5× and check_frontend_tests 4× (~45 min), each repeat 2 s after its deny. In `deliver`
// the escape is the same call with a trailing `# gate-reason: <why>` (3+ words) — the comment changes
// nothing the shell runs, and the run has to say what the earlier gate did not cover. Elsewhere the
// identical repeat stays the escape.
const GATE_REASON = /[ \t]*#[ \t]*gate-reason:[ \t]*([^\n]*)/;
export const withoutReason = (command) => String(command).replace(new RegExp(GATE_REASON, 'g'), '');
/** The named reason of a delivery-stage gate run, or null when absent or under three words. */
export function gateReason(command) {
  const said = GATE_REASON.exec(String(command))?.[1]?.trim() ?? '';
  return said.split(/\s+/).filter((w) => /[\p{L}\p{N}]/u.test(w)).length >= 3 ? said : null;
}
/** Dispatcher hook (items.mjs): in a delivery stage a logged identical repeat lifts nothing here. */
export const repeatEscapes = () => groupStage() !== 'deliver';
const REASON_FORM =
  'In the delivery stage a bare repeat does not lift this: if this run is still needed, repeat the call ' +
  'with `# gate-reason: <what changed since that run that narrow checks cannot cover>` at its end.';
/**
 * The deny's last sentence for a delivery-stage call. A call that already carries a reason is told why it
 * lifted nothing (g9 27.10 19:47: three gate calls, each with a valid reason but no refusal of that same
 * command before it, got the text asking for the reason they carried, and the group read the kit's source
 * for 3 min to learn the rule) — and this refusal is the one its repeat needs.
 */
function reasonFormFor(command) {
  if (!GATE_REASON.exec(String(command))?.[1]?.trim()) return REASON_FORM;
  if (!gateReason(command))
    return (
      'Your `# gate-reason` has under three words: name what changed since that run that narrow checks ' +
      'cannot cover, then repeat this call with it.'
    );
  return (
    'Your `# gate-reason` was read, but it lifts only a refusal of this same command and none stood before ' +
    'it — this deny is that refusal: repeat this exact call, reason included, and it runs.'
  );
}

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

/**
 * Delivery stage: the escape is a refused gate repeated WITH a named reason (`gateReason`). The refused
 * call is the same command without the reason comment — in the transcript, or (Qwen, Codex: no readable
 * transcript) in the kit's session log, where the bare command's deny by this item is the latest one.
 */
function reasonedRepeat(input, typed, events) {
  if (!gateReason(typed)) return false;
  const flat = (text) => withoutReason(text).replace(/\s+/g, ' ').trim();
  const bare = flat(typed);
  if (wasJustRefused(events, input.tool_name, (other) => flat(other?.command ?? '') === bare))
    return true;
  const log = foreignLog(input);
  if (!log) return false;
  const key = callKey({
    ...input,
    tool_input: { ...input.tool_input, command: withoutReason(typed) },
  });
  let seen = 0;
  for (let i = log.length - 1; i >= 0 && seen < 40; i--) {
    const e = log[i];
    if ((e.kind !== 'call' && e.kind !== 'deny') || e.tool !== input.tool_name) continue;
    seen++;
    if (e.key === key) return e.kind === 'deny' && e.item === 'gate-at-end';
  }
  return false;
}

export default function gateAtEnd(input) {
  const tool = input?.tool_name;
  if (tool !== 'Bash' && tool !== 'PowerShell') return null;
  if (inSubagent(input)) return null;
  const typed = String(input.tool_input?.command ?? '');
  // The reason comment is no part of the gate: every key and kind below is read without it.
  const command = withoutReason(typed);
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

  // Not escapable by a repeat: the delivery stage that follows is where the gate runs, and a repeat
  // here would only spend the 13–20 min run twice. Its parts count as the gate too (g9 25.10: denied
  // `check_frontend.mjs`, the group ran the whole inst-admin-ui suite by hand — 857 files, 350 s).
  const stage = groupStage();
  const gateAhead = Boolean(stage && stage !== 'deliver' && deliverAhead());
  const whole = gateAhead ? wholeSuiteRun(command) : null;
  if (whole) {
    return deny(
      `gate-at-end: \`${whole.slice(0, 160)}\` runs a test suite whole (no test file, folder or filter), and in ` +
        `the ${stage} stage of a panel split group that is the gate's test half: the full suite runs ONCE, in the ` +
        'delivery stage that follows, on the final tree. Here run the tests of the files you touched: ' +
        '`cd <package> && npx vitest run <their test files>` or `npx vitest related <files> --run`, `pytest <file>`.',
    );
  }
  if (!isGateRun(command, input.cwd)) return null;
  if (gateAhead) {
    return deny(
      `gate-at-end: this is the ${stage} stage of a panel split group, and a delivery stage follows it: the ` +
        "group's full project checks run ONCE, there, on the final tree. That run is what satisfies a project " +
        'rule asking for full checks before "done". Its parts count as the gate too: a whole-suite test run ' +
        '(`test:ci -- src`, `vitest run` with no file) is refused here as well. Check only what you touched: the ' +
        'tests of the touched files (`vitest related <files> --run`, `pytest <file>`), lint and type-check of those ' +
        'files or their package.',
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
  // Delivery stage, not escapable by a repeat (that is exactly the fix → full gate loop): after a red
  // full gate and an edit, the next full gate waits for a narrow check that passes on the fixed code.
  if (stage === 'deliver') {
    const ran = previousGates(events, raw, loadState(statePath(input)), input.cwd);
    const last = ran[ran.length - 1];
    if (
      last?.outcome === 'red' &&
      editsAfter(events, last.index) > 0 &&
      !narrowGreenAfter(events, raw, last.index, input.cwd)
    ) {
      return deny(
        `gate-at-end: the full gate at ${hhmm(last.ts)} was red and the code was edited since. In the delivery ` +
          'stage the next full gate waits until the red checks pass narrowly on the fixed code: re-run only ' +
          'them — `cd <package> && npm run lint:ci` / `npm run type-check`, `npx vitest related <files> --run`, ' +
          '`pytest <file>`, `npx eslint <files>` — then the full gate once, on the final tree.',
      );
    }
  }
  const flat = (text) =>
    String(text ?? '')
      .replace(/\s+/g, ' ')
      .trim();
  const deliver = stage === 'deliver';
  if (
    deliver
      ? reasonedRepeat(input, typed, events)
      : wasJustRefused(events, tool, (other) => flat(other?.command) === flat(typed))
  )
    return null;
  const reasonForm = deliver ? reasonFormFor(typed) : REASON_FORM;
  const again = (when) => (deliver ? reasonForm : `Repeat this exact call ${when}.`);

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
          `result instead of starting a second one. ${again('only if that run is gone (its stage ended without a result)')}`,
      );
    }
    return deny(
      `gate-at-end: the full gate already ran on exactly this tree (git tree ${copy.tree.slice(0, 12)}) ${where} — ` +
        `${outcome}. That result is authoritative: read it (transcript ${entry.transcript}, tool_use_id ${entry.id}, ` +
        `or its log) instead of re-running; red → fix, then re-run only the red checks, narrowly. ${again('only for a suspected flaky run')}`,
    );
  }

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
    // The delivery stage IS the delivery: its one more full gate belongs on the final tree, after the
    // last edit — the follow-up text below («runs at delivery when the user asks…») would be wrong here.
    if (deliver && prev.outcome !== 'red') {
      return deny(
        `gate-at-end: the full gate already ran at ${hhmm(prev.ts)} (${prev.outcome}) in this delivery stage; ` +
          `${edits} edit(s) since. Check them narrowly first — the tests of the touched files (\`vitest related ` +
          '<files> --run`, `pytest <file>`), lint and type-check of those files or their package. The full gate ' +
          'runs once more, on the FINAL tree, after the last edit. ' +
          reasonForm,
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
  if (copy && input.transcript_path) {
    saveLedger(copy.gitDir, [
      ...ledger.filter((r) => r.id !== id),
      { tree: copy.tree, cmd, id, transcript: input.transcript_path, ts: Date.now(), stage },
    ]);
  }
  return null;
}
