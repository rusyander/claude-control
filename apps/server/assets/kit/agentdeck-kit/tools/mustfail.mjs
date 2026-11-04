#!/usr/bin/env node
// mustfail — proves a check can go RED before its green run is believed.
//
// The invariant ("a check that cannot go red is decoration") has lived in CLAUDE.md as a habit since
// 17.09.2026. A habit is skippable; this is not. The mutation is the cheapest one that is always
// available and always meaningful: put a changed file back to its base revision and re-run the check.
// A file whose revert leaves the suite green is a file the suite does not actually cover, whatever
// `@covers` claims and whatever the coverage percentage says.
//
//   node <kit>/tools/mustfail.mjs --cmd "npm run test:ci" [--base origin/main]   # default: critical files, own tests only, 10 min/package
//   node <kit>/tools/mustfail.mjs --cmd "pytest {tests}"            # any runner: {tests} = the test files picked per file
//   node <kit>/tools/mustfail.mjs --cmd "..." --files a.ts,b.ts     # an explicit list instead of the critical files
//   node <kit>/tools/mustfail.mjs --cmd "..." --all                 # every behaviour-bearing changed file (explicit ask only)
//   node <kit>/tools/mustfail.mjs --cmd "..." --quick               # one run, all files reverted at once
//   node <kit>/tools/mustfail.mjs --cmd "..." --mutants plan.json   # new tests, old code
//   node <kit>/tools/mustfail.mjs --cmd "npx vitest run {spec}" --mutants plan.json   # each mutant: its own test file
//     (plan field `spec` = the mutant's test file; unset → the one test file listed in --cmd that names `test`)
//   node <kit>/tools/mustfail.mjs --cmd "..." --mutate src/x.ts --find "a >= b" --replace "a > b" [--test "name"]
//
// Scope: the CRITICAL changed files by default, not every changed file — every file of a
// critical kind, ranked hook · store · service/API · util · validation/form → other logic → page with logic →
// component with logic, then changed lines + branches, then path. Left out and named: markup without logic,
// type-only files, constants, barrels, styles, locales, test plumbing, configs, new and deleted files. Discovery
// stays inside --cwd. No file-count cap: the limit is a TIME BUDGET per package (nearest package.json / go.mod /
// pyproject.toml …), --budget minutes, default 10. The cost of each file is estimated BEFORE its run (picked test
// files × the measured baseline); what does not fit is printed by name as «UNCHECKED (budget)» up front, and a
// rerun resumes from the memo. --max N = an explicit cap per package (it caps --files too). --all = every
// behaviour-bearing changed file, ranked the same way; --files = an explicit list, in its own order.
//
// Test selection: `vitest related {file}` per file walked hundreds of test files (a large frontend package:
// ~15 min per file, a 33-file run crashed the worker at 453 test files), while the file's own
// directory ran in 73–99 s with the same RED. So when --cmd runs vitest or jest (directly or via a package.json
// script) or holds {tests}, each reverted file runs ONLY its own tests, cheapest exact source first:
// (a) test files whose `@covers` names it or its directory, plus its sibling <name>.test.<ext>; else (b) the tests
// in its own directory; else (c) the static import graph, cut to the --graph-cap (8) nearest by path distance —
// the cut is printed. No test found → GREEN «not covered», no run. Baseline = ONE run of the union of the picked
// tests per package, never the whole suite; each revert run stops at the first failure (--bail=1). Other commands
// (go test, a node script) keep the legacy modes under the same budget; --no-select forces them.
//
// Legacy modes: {file} (relative to --cwd) and {abs} in --cmd make every run about ONE file: its own baseline,
// its own revert (for vitest/jest/pytest one baseline over all files replaces the per-file ones). Measured
// 18.09.2026: four files against a one-minute suite took 5m21s, because every revert re-ran everything — and a
// tool that takes five minutes is a tool that gets skipped, which is the only way this check ever fails.
// Un-narrowed and more than two files: one combined revert runs first, because GREEN there already is the verdict
// for the whole change. `--quick`: one run with everything reverted answers whether the change is covered at all.
//
// Exit 0 = every behaviour-bearing changed file made the check go red. Exit 1 = at least one stayed
// green (report names which). Exit 2 = could not run (dirty state, check already red, no targets).
//
// Safety: the working tree is modified and put back. Originals are copied BEFORE the first write and
// every write is journaled before it happens; restoration runs in a finally and on SIGINT/SIGTERM/
// SIGHUP/SIGBREAK, and every restored file is verified byte-for-byte. A restore that fails prints the
// backup and exits 2 — losing the user's uncommitted work is worse than any missing verdict.
// A HARD kill (TerminateProcess, SIGKILL, reboot) runs none of that: the next start settles the
// journal first (see "crash journal"). `--recover` does only that and exits.
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  readFileSync,
  writeFileSync,
  mkdirSync,
  existsSync,
  rmSync,
  unlinkSync,
  readdirSync,
  renameSync,
  realpathSync,
  copyFileSync,
} from 'node:fs';
import { join, dirname, posix, resolve, basename, isAbsolute, relative } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const argv = process.argv.slice(2);
const flag = (name, fallback = null) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : fallback;
};
const has = (name) => argv.includes(`--${name}`);

// --help prints the header above (usage, modes, exit codes, safety). Without it a lane asked for help,
// got only "--cmd is required" and read the source instead (live review 18.10.2026: 3 calls, 5k chars).
// The --mutants plan shape is printed too: fix and verify sessions each read runMutants' source to learn
// it (4 calls). The example line is valid input — the test parses it.
const MUTANT_PLAN_HELP = [
  '--mutants <plan.json> — a JSON array (one object = one mutant); the identity control runs by itself:',
  '  file     string, required — path relative to --cwd (absolute works)',
  '  find     string, required, non-empty — exact text; must occur once, else set nth',
  '  replace  string, required — the break; "" deletes; equal to find = refused (that is the control)',
  '  test     string, optional — substring of the FAIL line of the test that must kill it; another test failing = not proof',
  '  spec     string, optional — the test file holding that test; the mutant runs only it ({spec} in --cmd, else it',
  '           replaces the test files --cmd lists). Unset: the one listed test file whose source names `test`',
  '  nth      number, optional — which occurrence of find (1-based) when it repeats',
  '  multi-line find/replace: write \\n, a CRLF file is matched too',
  'Example:',
  '[{"file":"src/limits.js","find":"if (n >= max)","replace":"if (n > max)","test":"rejects at the cap"}]',
].join('\n');
if (has('help') || argv.includes('-h')) {
  const head = [];
  for (const line of readFileSync(new URL(import.meta.url), 'utf8')
    .split(/\r?\n/)
    .slice(1)) {
    if (!line.startsWith('//')) break;
    head.push(line.replace(/^\/\/ ?/, ''));
  }
  console.log(
    `${head.join('\n')}\n\nFlags: --cmd (required) --base <rev> --cwd <dir> --files a,b --all --max <n per package; default: no cap> ` +
      `--graph-cap <n, default 8: directory / graph tests per file; 0 = @covers and sibling only> --quick --trust-green (gate just green, skip the baseline) ` +
      `--budget <min per package, default 10> --timeout <ms per run> --fresh --recover --no-select --mutants <plan.json> --mutate/--find/--replace [--test]\n` +
      `Selection (vitest/jest/node --test/{tests}) — never a hand-made fixed-suite wrapper: the picked tests of every file are ` +
      `printed before any run, then the cost estimate and the budget cut. A baseline red before any revert whose runner NAMES ` +
      `its failing tests (TAP, go -v, pytest, vitest/jest, node spec) is a known-red set: RED = a new failing test; unnamed red ` +
      `→ NO-BASE. UNCHECKED never fails the run: rerun the SAME command until no row is left — proven files and the ` +
      `baseline come from the memo (a RED holds for the tree under any command).\n` +
      `Legacy (--no-select, or a runner that takes no test list): vitest «related {file}» → graph mode (2 runs + tie-breaks): ` +
      `--no-graph (old per-file runs), --no-sibling (graph only; both imply --no-select). A check that runs no test at all ` +
      `stops at once (exit 2). Verdicts are memoised per tree; --fresh ignores the memo.\n\n` +
      MUTANT_PLAN_HELP,
  );
  process.exit(0);
}

const CMD = flag('cmd');
const BASE = flag('base');
const CWD = flag('cwd', process.cwd());
// --max is opt-in (the budget is the limit, not a file count): unset = no cap.
const MAX_SET = argv.includes('--max');
const MAX = MAX_SET ? Number(flag('max', '6')) : Infinity;
const ALL = has('all');
// How many import-graph tests one file may pull in (step c of the selection); the nearest by path win.
const GRAPH_CAP = Number(flag('graph-cap', '8'));
const QUICK = has('quick');
// Graph mode knobs: the gate just went green → no baseline run; a wall budget past which the per-file
// tie-break runs stop and the rest are printed as not checked instead of blocking (owner 19.10.2026:
// ~90 % of the verdicts in ~20 min beats 100 % in 5 h that nobody waits for).
const TRUST_GREEN = has('trust-green');
// 8, not 20: whole-diff runs cost split groups hours a day. 10 per PACKAGE since the budget replaced the
// 6-file cap as the limit of the default scope.
const BUDGET_MS = Number(flag('budget', '10')) * 60_000;

// ---- crash journal (finding 54, live split run 24.09.2026) -------------------------------------------
// A split group's CLI ended its turn under a background mustfail; the kill ran no handler and the tree
// kept a file REVERTED to base — three groups, one noticed only in review. So: every write is recorded
// BEFORE it happens, next to the repository (the per-worktree git dir via `--git-path`: survives
// reboots, one per tree, invisible to status; a temp dir outside git), and every start settles what a
// dead run left first. A file still holding bytes this tool wrote → put back from the backup. A file
// changed since → never overwritten: refuse, name the backup. A live run in the same tree → refuse:
// two runs would back up each other's mutations as originals.
const sha = (buf) => (buf === null ? 'absent' : createHash('sha1').update(buf).digest('hex'));
const gitOut = (args) => {
  const r = spawnSync('git', args, { cwd: CWD, encoding: 'utf8' });
  return r.status === 0 ? r.stdout.trim() : '';
};
const longPath = (p) => {
  try {
    return realpathSync.native(p);
  } catch {
    return resolve(p);
  }
};
const TOP = gitOut(['rev-parse', '--show-toplevel']);
const STATE = TOP
  ? resolve(CWD, gitOut(['rev-parse', '--git-path', 'mustfail']))
  : join(tmpdir(), 'claude-mustfail');
const SCOPE = (TOP || longPath(CWD)).replace(/\\/g, '/').toLowerCase();
const JOURNAL = join(STATE, `journal-${process.pid}.json`);
// Every check this run spawns inherits it: a repo-side guard may refuse a suite started while a FOREIGN run
// holds the tree mutated, and must let this run's own checks through (agents sharing one working copy read
// each other's mutants as flaky tests).
process.env.MUSTFAIL_PID = String(process.pid);
const BACKUPS = join(STATE, String(process.pid));
const journal = {
  pid: process.pid,
  scope: SCOPE,
  started: new Date().toISOString(),
  cmd: CMD,
  files: {},
};

function persist() {
  mkdirSync(STATE, { recursive: true });
  writeFileSync(`${JOURNAL}.tmp`, JSON.stringify(journal));
  renameSync(`${JOURNAL}.tmp`, JOURNAL);
}
/** Back up the original of `full` once, before the first write to it. @returns the backup path */
function track(full, before) {
  const known = journal.files[full];
  if (known) return known.backup;
  mkdirSync(BACKUPS, { recursive: true });
  const backup = join(BACKUPS, `${Object.keys(journal.files).length}-${basename(full)}`);
  if (before !== null) {
    writeFileSync(backup, before);
    if (!readFileSync(backup).equals(before)) throw new Error(`backup of ${full} did not verify`);
  }
  journal.files[full] = { backup, before: sha(before), written: [] };
  persist();
  return backup;
}
/** Journal the bytes about to be written to `full` — strictly BEFORE the write. */
function intend(full, bytes) {
  const e = journal.files[full];
  const h = sha(bytes);
  if (!e.written.includes(h)) {
    e.written.push(h);
    persist();
  }
}
/** A file someone edited mid-run was left as is — its plan-time original stays on disk for a human. */
let keepBackups = false;
/** Every file is back: the journal and the backups have nothing left to protect. */
function closeJournal() {
  try {
    rmSync(JOURNAL, { force: true });
    if (!keepBackups) rmSync(BACKUPS, { recursive: true, force: true });
  } catch {
    /* a leftover journal whose files all match their originals settles silently next start */
  }
}
const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === 'EPERM';
  }
};
const refuse = (msg) => {
  console.error(`mustfail: ${msg}`);
  process.exit(2);
};

const busy = (j) =>
  refuse(
    `another mustfail run (pid ${j.pid}, started ${j.started}) is rewriting this tree right now — a second run would ` +
      `back up its mutations as originals. Wait for it; if pid ${j.pid} is not mustfail, delete ${j.file}.`,
  );

/**
 * Settle journals of dead runs in this tree. @returns the live foreign ones. A journal under OUR pid but
 * not this run's start is a dead run whose pid came back (reboot, pid reuse): its files are put back, never
 * overwritten by this run's journal of the same name — the backups folder is the same one too.
 */
function settle() {
  let names;
  try {
    names = readdirSync(STATE).filter((n) => /^journal-\d+\.json$/.test(n));
  } catch {
    return [];
  }
  const live = [];
  for (const n of names) {
    const file = join(STATE, n);
    let j;
    try {
      j = JSON.parse(readFileSync(file, 'utf8'));
    } catch {
      refuse(
        `unreadable journal ${file} — a killed run may have left files rewritten. Check them against git, then delete it.`,
      );
    }
    if (j.scope !== SCOPE) continue;
    const own = j.pid === process.pid;
    if (own && j.started === journal.started) continue;
    if (!own && alive(j.pid)) {
      live.push({ pid: j.pid, started: j.started, file });
      continue;
    }
    const restored = [];
    const stuck = [];
    for (const [full, e] of Object.entries(j.files ?? {})) {
      const now = sha(existsSync(full) ? readFileSync(full) : null);
      if (now === e.before) continue;
      if (!e.written.includes(now)) {
        stuck.push(`${full} — changed after that run died; original in ${e.backup}`);
        continue;
      }
      try {
        if (e.before === 'absent') unlinkSync(full);
        else {
          const orig = readFileSync(e.backup);
          if (sha(orig) !== e.before) throw new Error('backup does not match the journal');
          writeFileSync(full, orig);
          if (sha(readFileSync(full)) !== e.before) throw new Error('write did not verify');
        }
        restored.push(full);
      } catch (err) {
        stuck.push(`${full} — ${err.message}; original in ${e.backup}`);
      }
    }
    if (restored.length)
      process.stdout.write(
        `mustfail: restored ${restored.length} file(s) a killed run (pid ${j.pid}, ${j.started}) left rewritten: ${restored.join(', ')}\n`,
      );
    if (stuck.length)
      refuse(
        `a killed run (pid ${j.pid}, ${j.started}) left files this tool cannot safely put back:\n  ${stuck.join('\n  ')}\nRestore them by hand, then delete ${file}.`,
      );
    rmSync(file, { force: true });
    rmSync(join(STATE, String(j.pid)), { recursive: true, force: true });
  }
  return live;
}

const first = settle();
if (first.length) busy(first[0]);
if (has('recover')) process.exit(0);

// A console closed under the run (SIGHUP) or Ctrl+Break (SIGBREAK) still leaves time to put files back.
const SIGNALS = [
  'SIGINT',
  'SIGTERM',
  'SIGHUP',
  ...(process.platform === 'win32' ? ['SIGBREAK'] : []),
];

if (!CMD) {
  console.error('mustfail: --cmd "<command that must be able to go red>" is required');
  process.exit(2);
}

// The tree is claimed BEFORE the first check run, not at the first write: baselines run long, and a second run
// starting under them saw no journal, ran its own and then both rewrote one tree (core review A1r2-F01, 29.10).
// Two runs claiming at once both see each other on the re-read: the later start (then the higher pid) yields.
persist();
process.on('exit', () => {
  if (!Object.keys(journal.files).length) rmSync(JOURNAL, { force: true });
});
const before = (a, b) => a.started < b.started || (a.started === b.started && a.pid < b.pid);
const earlier = settle().find((j) => before(j, journal));
if (earlier) busy(earlier);

// Which shell runs the check is not a detail: on Windows `shell: true` is cmd.exe, and a POSIX-shaped
// command handed to it can SUCCEED where it was meant to fail. Measured 18.09.2026 while testing this
// very tool — `node -e 'process.exit(1)'` exited 0 under cmd.exe, because the single quotes became part
// of the script and nothing ever called exit. A false green inside the thing that exists to catch false
// greens is the worst possible bug here, so the user's own shell wins when there is one. On POSIX only
// a POSIX-family one: fish or nu as the login shell broke every bash-shaped check line.
const POSIX_SHELL = /(?:^|\/)(?:ba|z|da|k|a)?sh$/;
function checkShell() {
  const login = process.env.SHELL;
  const found = Boolean(login) && existsSync(login);
  if (process.platform === 'win32') return found ? login : true;
  return found && POSIX_SHELL.test(login) ? login : '/bin/sh';
}
const SHELL = checkShell();
// A revert that deletes an export or a module makes the check fail on IMPORT, before any assertion
// runs. That red proves the symbol existed, not that its behaviour is checked — a test that computes
// its expectation the way the code does earns it exactly like a real one. Named apart in the table.
const SYMBOL_RED =
  /does not provide an export named|Cannot find module|is not a function|is not defined|is not a constructor|cannot import name|ModuleNotFoundError|ImportError|has no attribute|Failed to resolve import|unresolved import|error TS2(?:304|305|307|339|551)|\bundefined: \w+|has no field or method|SyntaxError/;

// ---- targeted mutants: a new test over code the change did not touch --------------------------------
// Reverting to base proves nothing there — old code has no base to fail against. The proof is a mutant:
// a one-line break of exactly the behaviour the test claims, which must turn the check RED on an
// assertion. Real reviews found the survivors by hand (a race test green on the pre-fix tree; a
// condition made unconditional, suite still green); this makes that a command.
// Async, because a timeout must kill the whole tree: spawnSync's timeout kills only the shell, and the
// test runner under it kept spinning (fixture run 23.09.2026) — a mutant loop would burn a core for good.
function killTree(pid) {
  if (process.platform === 'win32')
    spawnSync('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true });
  else
    try {
      process.kill(-pid, 'SIGKILL');
    } catch {
      /* already gone */
    }
}
function execTree(cmd, timeout, env) {
  return new Promise((done) => {
    const t0 = Date.now();
    const child = spawn(cmd, {
      cwd: CWD,
      shell: SHELL,
      windowsHide: true,
      detached: process.platform !== 'win32',
      env: env ? { ...process.env, ...env } : process.env,
    });
    let out = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (out += d));
    let timedOut = false;
    const timer = timeout
      ? setTimeout(() => {
          timedOut = true;
          killTree(child.pid);
        }, timeout)
      : null;
    child.on('close', (status) => {
      clearTimeout(timer);
      done({ status: status ?? 1, timedOut, out, ms: Date.now() - t0 });
    });
  });
}

if (flag('mutants') || argv.includes('--mutate')) process.exit(await runMutants());

async function runMutants() {
  // --replace "" is a legitimate mutant (delete a call), so these read the raw next argument.
  const raw = (name) => {
    const i = argv.indexOf(`--${name}`);
    return i >= 0 && i + 1 < argv.length ? argv[i + 1] : null;
  };
  let plan;
  if (flag('mutants')) {
    // Relative to --cwd, then to the shell's cwd: `--cwd pkg --mutants .agent/tmp/m.json` failed ENOENT with
    // the plan at the repo root the shell stood in (the redirect on the same line resolved there). A plan
    // found nowhere names every path tried, so the retry needs no guess.
    const tried = [...new Set([resolve(CWD, flag('mutants')), resolve(flag('mutants'))])];
    const at = tried.find((p) => existsSync(p)) ?? tried[0];
    try {
      plan = JSON.parse(readFileSync(at, 'utf8'));
    } catch (e) {
      const where =
        e.code === 'ENOENT' ? `no such file — tried ${tried.join(' and ')}` : `${at}: ${e.message}`;
      console.error(`mustfail: cannot read the mutant plan — ${where}`);
      return 2;
    }
    if (!Array.isArray(plan)) plan = [plan];
    // An empty plan (review-sweep over lines with nothing to mutate) proves nothing: exit 2 like K7, not a crash.
    if (!plan.length) {
      console.error('mustfail: nothing proven — the mutant plan is empty.');
      return 2;
    }
  } else {
    plan = [
      {
        file: raw('mutate'),
        find: raw('find'),
        replace: raw('replace'),
        test: raw('test'),
        spec: raw('spec'),
      },
    ];
  }

  // Narrowing: `--cmd "npm run test:ci -- <15 files>"` ran all 15 test files for each of 21 mutants — 923 s.
  // The proof a mutant asks for is a failure of its NAMED test, and that test lives in one file; a kill
  // anywhere else is RED·wrong, not proof. So each mutant runs only its own test file: the plan's `spec`,
  // else the one test file listed in --cmd whose source contains the `test` name. It fills {spec} in --cmd,
  // or takes the place of the test files --cmd lists. Nothing to narrow by → the whole --cmd, as before.
  const IS_SPEC = /\.(?:test|spec)\.[cm]?[jt]sx?$|_test\.py$|(?:^|[\\/])test_[^\\/]+\.py$/i;
  const unquote = (t) => t.replace(/^(["'])(.*)\1$/, '$2');
  const SLOT = CMD.includes('{spec}');
  const listed = CMD.split(/\s+/)
    .map(unquote)
    .filter((t) => IS_SPEC.test(t));
  /** `cmd` run against `spec` only: {spec} filled, or the listed test files collapsed into it. */
  const narrowTo = (cmd, spec) => {
    const shown = /\s/.test(spec) ? `"${spec}"` : spec;
    if (SLOT) return cmd.replaceAll('{spec}', shown);
    let placed = false;
    return cmd
      .split(/(\s+)/)
      .map((part) => {
        if (!part.trim() || !IS_SPEC.test(unquote(part))) return part;
        if (placed) return null;
        placed = true;
        return shown;
      })
      .reduce(
        (acc, part, i, all) =>
          part === null || (all[i + 1] === null && !part.trim()) ? acc : acc + part,
        '',
      );
  };
  /** The mutant's own test file and where it came from ('plan' | 'test'), or null = run the whole --cmd. */
  const specOf = (m) => {
    if (typeof m.spec === 'string' && m.spec)
      return { spec: m.spec.replaceAll('\\', '/'), how: 'plan' };
    if (typeof m.test !== 'string' || !m.test.trim() || !listed.length) return null;
    // A FAIL line reads «file > describe > it»; the source holds only the last title literally.
    const needle = m.test.split(' > ').pop().trim();
    const hits = listed.filter((f) => {
      try {
        return readFileSync(resolve(CWD, f), 'utf8').includes(needle);
      } catch {
        return false;
      }
    });
    return hits.length === 1 ? { spec: hits[0], how: 'test' } : null;
  };

  // Every mutant is checked before the first run: a stale or ambiguous `find` is a plan bug, and
  // discovering it after ten suite runs wastes all of them.
  const problems = [];
  const muts = plan.map((m, i) => {
    const tag = `#${i + 1} ${m?.file ?? '?'}`;
    if (
      !m ||
      typeof m.file !== 'string' ||
      typeof m.find !== 'string' ||
      typeof m.replace !== 'string' ||
      !m.find
    ) {
      problems.push(`${tag}: needs {file, find, replace} with a non-empty find`);
      return null;
    }
    const full = resolve(CWD, m.file);
    if (!existsSync(full)) {
      problems.push(`${tag}: file not found`);
      return null;
    }
    const before = readFileSync(full);
    const text = before.toString('utf8');
    if (!Buffer.from(text, 'utf8').equals(before)) {
      problems.push(
        `${tag}: not UTF-8 text — a mutant written through a string would change other bytes too`,
      );
      return null;
    }
    let { find, replace } = m;
    // The plan is written with \n; a CRLF file never matches a multi-line find without this.
    if (!text.includes(find) && find.includes('\n') && text.includes('\r\n')) {
      find = find.replace(/\r?\n/g, '\r\n');
      replace = replace.replace(/\r?\n/g, '\r\n');
    }
    const at = [];
    for (let k = text.indexOf(find); k >= 0; k = text.indexOf(find, k + find.length)) at.push(k);
    const lineOf = (k) => text.slice(0, k).split('\n').length;
    const nth = m.nth == null ? null : Number(m.nth);
    if (!at.length) problems.push(`${tag}: find not in the file (stale plan?)`);
    else if (find === replace)
      problems.push(`${tag}: replace equals find — that is the control, which runs by itself`);
    else if (nth == null && at.length > 1)
      problems.push(
        `${tag}: find matches ${at.length}× (lines ${at.map(lineOf).join(', ')}) — lengthen it or set "nth"`,
      );
    else if (nth != null && !(nth >= 1 && nth <= at.length))
      problems.push(`${tag}: nth ${m.nth} outside 1..${at.length}`);
    const own = typeof m.spec === 'string' || m.spec == null ? specOf(m) : null;
    if (m.spec != null && (typeof m.spec !== 'string' || !m.spec))
      problems.push(`${tag}: spec must be a non-empty string`);
    else if (own?.how === 'plan' && !existsSync(resolve(CWD, own.spec)))
      problems.push(`${tag}: spec ${own.spec} not found`);
    else if (own?.how === 'plan' && !SLOT && !listed.length)
      problems.push(
        `${tag}: spec set, but --cmd has no {spec} and lists no test file to put it in place of — add {spec}`,
      );
    else if (SLOT && !own)
      problems.push(`${tag}: --cmd has {spec} — set "spec" (the mutant's test file)`);
    if (problems.length) return null;
    const k = at[(nth ?? 1) - 1];
    const mutated = Buffer.from(text.slice(0, k) + replace + text.slice(k + find.length), 'utf8');
    const identity = Buffer.from(text.slice(0, k) + find + text.slice(k + find.length), 'utf8');
    return { ...m, full, before, mutated, identity, line: lineOf(k), narrow: own };
  });
  if (problems.length) {
    console.error(`mustfail: the mutant plan cannot run:\n  ${problems.join('\n  ')}`);
    return 2;
  }

  const templated = /\{file\}|\{abs\}/.test(CMD);
  const wholeFor = (m) =>
    templated
      ? CMD.replaceAll('{file}', m.file.replaceAll('\\', '/')).replaceAll('{abs}', m.full)
      : CMD;
  const cmdFor = (m) => (m.narrow ? narrowTo(wholeFor(m), m.narrow.spec) : wholeFor(m));
  let spentMs = 0;
  const exec = async (cmd, timeout) => {
    const r = await execTree(cmd, timeout);
    spentMs += r.ms;
    return r;
  };

  process.stdout.write(`mustfail · mutants · ${muts.length} · ${CMD}\n`);
  const narrowed = muts.filter((m) => m.narrow).length;
  if (narrowed)
    process.stdout.write(
      `· own test file: ${narrowed} of ${muts.length} (the rest run the whole --cmd)\n`,
    );
  if (narrowed < muts.length && listed.length > 1)
    process.stdout.write(
      `· ${muts.length - narrowed} mutant(s) run all ${listed.length} test files of --cmd: give them "spec" — each run becomes one file\n`,
    );
  // Baseline per distinct command: every mutant is judged against a run that was green untouched.
  const slowest = new Map();
  const queue = [...new Set(muts.map(cmdFor))];
  for (let qi = 0; qi < queue.length; qi++) {
    const cmd = queue[qi];
    const t0 = Date.now();
    const r = await exec(cmd);
    slowest.set(cmd, Date.now() - t0);
    // A file the tool picked by test name may not stand alone (shared setup in a sibling): those mutants go
    // back to the whole --cmd instead of stopping the run. A `spec` the plan named red by itself is the plan's call.
    const picked =
      r.status !== 0 ? muts.filter((m) => m.narrow?.how === 'test' && cmdFor(m) === cmd) : [];
    if (picked.length) {
      process.stdout.write(
        `· ${picked[0].narrow.spec} is red on its own before any mutation — its mutants run the whole --cmd\n`,
      );
      for (const m of picked) {
        m.narrow = null;
        if (!slowest.has(cmdFor(m)) && !queue.includes(cmdFor(m))) queue.push(cmdFor(m));
      }
      continue;
    }
    if (r.status !== 0) {
      console.error(
        `\nmustfail: the check is ALREADY RED before any mutation — fix it first, a red check proves nothing.\n${r.out.split('\n').slice(-12).join('\n')}`,
      );
      return 2;
    }
  }
  // A mutant that loops forever must not hang the run; the test that would catch it has its own
  // timeout, ours is the backstop. A hang counts as detected, the way mutation testers count it.
  const timeoutFor = (cmd) => Number(flag('timeout')) || Math.max(60_000, 5 * slowest.get(cmd));

  let live = null; // the one file currently written, so a signal or a throw can put it back
  let liveBytes = null; // what this run wrote there — anything else is someone's edit, never overwritten
  const putBack = () => {
    if (!live) return true;
    const { full, before } = live;
    try {
      // A parallel agent edited the file during a mutant run; restoring the plan-time original
      // silently erased that edit. Bytes this run did not write are not its to put back.
      const now = existsSync(full) ? readFileSync(full) : null;
      if (now === null || !now.equals(liveBytes)) {
        keepBackups = true;
        console.error(
          `\nmustfail: ${full} CHANGED during the run (someone edited it) — left as is, not restored.\n` +
            `  The edit may have been made on top of the mutant: check the file for ${JSON.stringify(live.replace)} (was ${JSON.stringify(live.find)}).\n` +
            `  Plan-time original kept in ${journal.files[full]?.backup ?? BACKUPS}. Re-plan the mutants against the current file.`,
        );
        live = null;
        return false;
      }
      writeFileSync(full, before);
      if (readFileSync(full).equals(before)) {
        live = null;
        return true;
      }
    } catch {
      /* reported below */
    }
    console.error(
      `\nmustfail: COULD NOT RESTORE ${full} — the original is in ${journal.files[full]?.backup ?? BACKUPS}`,
    );
    return false;
  };
  for (const sig of SIGNALS)
    process.on(sig, () => {
      if (putBack()) closeJournal();
      process.exit(2);
    });
  const apply = (m, bytes) => {
    // The mutant was cut from the file as read at plan time; written over a newer file it would erase
    // the newer edit too. A file that moved since → stop, the plan no longer describes it.
    const now = existsSync(m.full) ? readFileSync(m.full) : null;
    if (now === null || !now.equals(m.before)) {
      console.error(
        `\nmustfail: ${m.full} changed since the plan was read (someone edited it) — mutant not written; re-plan against the current file.`,
      );
      return false;
    }
    track(m.full, m.before);
    intend(m.full, bytes);
    live = m;
    liveBytes = bytes;
    writeFileSync(m.full, bytes);
    return true;
  };

  // Failing-test lines as runners print them: vitest/jest (FAIL, ×, ✕, ●), node:test (✖, not ok),
  // go (--- FAIL), pytest (FAILED), playwright (✘). Used to name WHICH test killed a mutant — the
  // 23.09.2026 lesson: the first failure in the file is not necessarily the targeted one.
  const FAIL_LINE = /\bFAIL(?:ED)?\b|[×✕✖✗✘●]|\bnot ok\b/;
  // Red from a missing symbol, a compile error or zero collected tests is not a verdict about behaviour.
  // Runtime TypeErrors stay out of this list on purpose: a mutant that returns null and makes the caller
  // throw "is not a function" WAS noticed by the test.
  const BUILD_RED =
    /does not provide an export named|Cannot find module|cannot import name|ModuleNotFoundError|ImportError|Failed to resolve import|unresolved import|error TS\d{4}|\bundefined: \w+|has no field or method|SyntaxError|IndentationError|Transform failed|\[build failed\]|\[setup failed\]|No test files found|no tests to run|\[no test files\]|collected 0 items|no tests ran/;

  const rows = [];
  let exitCode = 0;
  try {
    // The control: `find` written back as itself through the same path, the same write, the same run.
    // It must SURVIVE. If it dies, the harness breaks tests by itself — a watcher cache, a path, line
    // endings — and every RED below would be noise (23.09.2026: 11/11 "killed" by file-not-found).
    const c = muts[0];
    if (!apply(c, c.identity)) return 2;
    const cr = await exec(cmdFor(c), timeoutFor(cmdFor(c)));
    if (!putBack()) return 2;
    if (cr.status !== 0) {
      console.error(
        `\nmustfail: the CONTROL mutant died — ${c.file} rewritten unchanged turned the check red, so no verdict below would mean anything.\n${cr.out.split('\n').slice(-12).join('\n')}`,
      );
      return 2;
    }
    rows.push([
      `${c.file}:${c.line}`,
      'control: unchanged',
      'GREEN',
      'control survived — the setup does not go red on its own',
    ]);

    for (const m of muts) {
      if (!apply(m, m.mutated)) return 2;
      const r = await exec(cmdFor(m), timeoutFor(cmdFor(m)));
      if (!putBack()) return 2;
      const failing = r.out
        .split('\n')
        .filter((l) => FAIL_LINE.test(l))
        .map((l) => l.trim());
      const named = m.test ? failing.find((l) => l.includes(m.test)) : null;
      const first = failing[0] ? failing[0].slice(0, 90) : '';
      const label = `${JSON.stringify(m.find).slice(1, -1)} → ${JSON.stringify(m.replace).slice(1, -1)}`;
      const shown = label.length > 60 ? `${label.slice(0, 57)}…` : label;
      let verdict;
      let note;
      if (r.timedOut)
        [verdict, note] = [
          'RED·timeout',
          'the check hung on the mutant — caught, but weaker than an assert',
        ];
      else if (r.status === 0)
        [verdict, note] = [
          'GREEN',
          `mutant survived${m.narrow ? ` in ${m.narrow.spec}` : ''} — no test catches this behaviour`,
        ];
      else if (named) [verdict, note] = ['RED', `killed by the named test: ${named.slice(0, 90)}`];
      else if (BUILD_RED.test(r.out))
        [verdict, note] = [
          'RED·build',
          'build/import/test collection failed — that is not a behaviour check',
        ];
      else if (m.test)
        [verdict, note] = [
          'RED·wrong',
          `the named test did not fail; failed: ${first || 'see output'}`,
        ];
      else
        [verdict, note] = [
          'RED',
          first ? `failed: ${first}` : 'check is red (test name not recognised — set "test")',
        ];
      if (verdict === 'GREEN' || verdict === 'RED·build' || verdict === 'RED·wrong') exitCode = 1;
      rows.push([`${m.file}:${m.line}`, shown, verdict, note]);
    }
  } finally {
    if (!putBack()) process.exit(2);
    closeJournal();
  }

  const w0 = Math.max(...rows.map((r) => r[0].length), 4);
  const w1 = Math.max(...rows.map((r) => r[1].length), 6);
  process.stdout.write(
    `\n| ${'Where'.padEnd(w0)} | ${'Mutant'.padEnd(w1)} | Verdict     | What it means  |\n`,
  );
  process.stdout.write(
    `|${'-'.repeat(w0 + 2)}|${'-'.repeat(w1 + 2)}|-------------|----------------|\n`,
  );
  for (const [a, b, v, n] of rows)
    process.stdout.write(`| ${a.padEnd(w0)} | ${b.padEnd(w1)} | ${v.padEnd(11)} | ${n} |\n`);
  const count = (v) => rows.slice(1).filter((r) => r[2] === v).length;
  const killed = count('RED') + count('RED·timeout');
  process.stdout.write(
    `\nMUSTFAIL·mutants: ${killed} killed · ${count('GREEN')} survived · ${count('RED·build')} by build · ` +
      `${count('RED·wrong')} by the wrong test · control survived · ${Math.round(spentMs / 1000)} s\n`,
  );
  if (exitCode)
    process.stdout.write(
      'A surviving mutant = the test cannot go red on this behaviour: strengthen the assert, or the test is about something else.\n' +
        'RED·build and RED·wrong are not proof: an assert must fail in the named test.\n',
    );
  return exitCode;
}

const git = (args, opts = {}) =>
  spawnSync('git', args, { cwd: CWD, encoding: 'utf8', maxBuffer: 64 << 20, ...opts });

const root = git(['rev-parse', '--show-toplevel']).stdout?.trim();
if (!root) {
  console.error('mustfail: not a git repository — the mutation needs a base revision to revert to');
  process.exit(2);
}

// A revert during a merge or rebase would be written into a half-finished tree and the restore would
// race the operation in progress. Refuse rather than guess. Where git keeps each marker is git's
// answer, never `<root>/.git/…`: in a linked worktree `.git` is a FILE and the markers live in
// `.git/worktrees/<name>/` — the old path check never fired in a split group's worktree (finding 94a).
for (const marker of [
  'MERGE_HEAD',
  'rebase-merge',
  'rebase-apply',
  'CHERRY_PICK_HEAD',
  'REVERT_HEAD',
]) {
  const at = git(['rev-parse', '--git-path', marker]).stdout?.trim();
  if (at && existsSync(resolve(CWD, at))) {
    console.error(`mustfail: ${marker} present — finish the merge/rebase/cherry-pick first`);
    process.exit(2);
  }
}

/** The base to revert to: an explicit --base, else the merge-base with the default branch, else HEAD. */
function resolveBase() {
  if (BASE) return BASE;

  for (const ref of ['origin/main', 'origin/master', 'main', 'master']) {
    if (git(['rev-parse', '--verify', '--quiet', ref]).status === 0) {
      // Three-dot semantics: what THIS branch changed, never what main moved on to. A two-dot range
      // on a diverged branch drags in foreign files and every verdict about them is noise.
      const mb = git(['merge-base', 'HEAD', ref]).stdout?.trim();
      if (mb) return mb;
    }
  }
  return 'HEAD';
}

const base = resolveBase();

// Source files only: a lockfile, a snapshot or a generated client reverting green says nothing about
// coverage, and reverting it is often a build break for reasons unrelated to behaviour.
const SOURCE = /\.(ts|tsx|js|jsx|mjs|cjs|go|py|rb|java|kt|cs|rs|php|swift|scala|sql|vue|svelte)$/i;
const NOT_BEHAVIOUR =
  /(^|[\\/])(node_modules|dist|build|vendor|__generated__|sqlcdb)[\\/]|[._-](test|spec)\.|_test\.go$|(^|[\\/])(test_[^\\/]+|conftest)\.py$|\.d\.ts$|lock\.json$|\.snap$/i;

// Relative to --cwd by way of git, never by comparing filesystem paths: `git rev-parse` answers with
// the long path while the caller may hold the 8.3 short one (C:\Users\LONGNA~1), and `relative()`
// between the two walks up to the drive root — found by this tool's own fixture test.
const PREFIX = (git(['rev-parse', '--show-prefix']).stdout || '').trim();

/**
 * A `--files` entry as a root-relative path: relative to --cwd first (like --mutants and every other
 * CLI), else relative to the root, else absolute. An entry found nowhere used to be read at the root
 * only, reported «new file — SKIP», and a table of SKIPs exited 0 — a false green (finding 94a).
 */
function explicitTarget(entry) {
  const known = (p) =>
    p && !p.startsWith('../') && p !== '..' && (existsSync(join(root, p)) || atBase(p) !== null);
  const rel = entry.replace(/\\/g, '/');
  if (!isAbsolute(entry))
    return [posix.normalize(PREFIX + rel), posix.normalize(rel)].find(known) ?? null;
  // Absolute: both sides through realpath, so an 8.3 short spelling meets git's long root.
  const fromAbs = relative(longPath(root), join(longPath(dirname(entry)), basename(entry))).replace(
    /\\/g,
    '/',
  );
  return known(fromAbs) ? fromAbs : null;
}

function targets() {
  const explicit = flag('files');
  if (explicit) {
    const out = [];
    const missing = [];
    for (const entry of explicit
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)) {
      const t = explicitTarget(entry);
      if (t && !out.includes(t)) out.push(t);
      else missing.push(entry);
    }
    if (missing.length)
      refuse(
        `--files entry not found in the tree or at ${base}: ${missing.join(', ')} (relative to --cwd, to the repository root, or absolute)`,
      );
    // The same behaviour filter as discovery: a locale JSON passed by hand made `vitest related` walk
    // the whole suite for a file no assertion can be about (L7.15, live group 19.10.2026).
    const dropped = out.filter((f) => !SOURCE.test(f) || NOT_BEHAVIOUR.test(f));
    if (dropped.length)
      process.stdout.write(`mustfail: not behaviour, skipped: ${dropped.join(', ')}\n`);
    const list = out.filter((f) => !dropped.includes(f));
    if (MAX_SET && list.length > MAX) overflow = list.splice(MAX);
    return list;
  }
  const seen = new Set();
  const skipped = new Set();
  const outside = new Set();
  for (const args of [
    ['diff', '--name-only', `${base}...HEAD`],
    ['diff', '--name-only'],
    ['diff', '--name-only', '--cached'],
  ]) {
    for (const line of (git(args).stdout || '').split('\n')) {
      const f = line.trim();
      if (!f) continue;
      if (!SOURCE.test(f) || NOT_BEHAVIOUR.test(f)) skipped.add(f);
      // The check runs in --cwd: a changed file of another package judged against these tests reads «not covered».
      else if (PREFIX && !f.startsWith(PREFIX)) outside.add(f);
      else seen.add(f);
    }
  }
  const tail = `not behaviour (tests, locales, non-code): ${skipped.size}${outside.size ? ` · outside --cwd: ${outside.size}` : ''}`;
  return criticalSample([...seen], tail);
}

// ---- critical sample -----------------------------------------------------------------------------------
// Judging every changed file cost groups hours a day; the proof is worth most where behaviour lives. Classified
// by path first, then by content (comments stripped): what a revert cannot meaningfully break is left out, the
// rest is ranked kind → (changed lines + branch count) → path, and the first --max of each package are judged.
let overflow = [];
const SAMPLE_OUT = [
  [/(^|\/)styles?\.[^/]+$|\.styles?\.[^/]+$|\.css\.[cm]?[jt]s$|(^|\/)app\/styles\//, 'styles'],
  [/(^|\/)(locales?|i18n|translations?)\//, 'locales'],
  [/(^|\/)types?\.[^/]+$|\.types?\.[^/]+$|(^|\/)types\/[^/]+$/, 'types only'],
  [/(^|\/)(constants?|consts?)\.[^/]+$|\.constants?\.[^/]+$|(^|\/)constants\/[^/]+$/, 'constants'],
  [
    /(^|\/)(testing|test-utils|__mocks__|mocks?|fixtures?|__fixtures__|stories)\/|\.stories\.[^/]+$|\.mocks?\.[^/]+$/,
    'test plumbing',
  ],
  [
    /(^|\/)[^/]+\.config\.[cm]?[jt]s$|(^|\/)(main|setupTests|setup-tests)\.[cm]?[jt]sx?$|(^|\/)(conftest|settings|wsgi|asgi|manage)\.py$/,
    'config / entry point',
  ],
];
const VALIDATION = 'validation / form';
const SAMPLE_TIERS = [
  [/(^|\/)use[A-Z][\w-]*(\/|\.[^/]+$)/, 'hook'],
  [
    /(^|\/)(stores?|state|slices?|reducers?|machines?)(\/|\.[^/]+$)|[a-z](Store|Slice|Reducer|Machine)\.[^/]+$|\.(store|slice|reducer)\.[^/]+$/,
    'store / reducer',
  ],
  [
    /(^|\/)(services?|api|clients?|handlers?|repositor(?:y|ies)|controllers?)(\/|\.[^/]+$)|[a-z](Service|Api|Client|Handler|Repository|Controller)\.[^/]+$|\.(service|api|client|handler|controller)\.[^/]+$/,
    'service / API',
  ],
  [
    /(^|\/)(utils?|lib|libs|helpers?)(\/|\.[^/]+$)|[a-z](Utils?|Helpers?)\.[^/]+$|\.(utils?|helpers?)\.[^/]+$/,
    'util',
  ],
  [
    /(^|\/)(validat\w*|schemas?|forms?)(\/|\.[^/]+$)|[a-z](Schema|Validator|Validation)\.[^/]+$|\.(schema|validator|validation)\.[^/]+$|(^|\/)use\w*Form\b/,
    VALIDATION,
  ],
];
const PAGE = /(^|\/)(pages?|routes?|views?|screens?)\//i;
const TESTS_ALLOW = /^\/\/\s*tests-allow:\s*\S/m; // a project waiver: «this file has no behaviour»
const STMT_JS = /\b(?:if|switch|for|while)\s*\(|\bcatch\b|\bawait\b|\bthrow\b|\btry\s*\{/g;
const STMT_WORDS =
  /\b(?:if|elif|for|while|switch|select|case|except|rescue|unless|try|raise|panic)\b/g;
const EXPR_BRANCH =
  /&&|\|\||\?\?|[^?\s]\s*\?\s+[^.?:\s]|\.(?:filter|reduce|find|findIndex|some|every|sort|flatMap)\(/g;
const HOOK_CALL = /\buse[A-Z]\w*\s*\(/g;
const FUNC = /=>|\bfunction\b|\bdef\s+\w|\bfunc\s|\bclass\s+\w|\bfn\s+\w|\blambda\b/g;
const RUNTIME_DECL =
  /\b(?:const|let|var|function|class|enum)\s|\bexport\s+default\b|module\.exports|\bexports\./;
const tally = (re, s) => (s.match(re) || []).length;
const extOf = (p) => (/\.([^./]+)$/.exec(p)?.[1] ?? '').toLowerCase();

function stripComments(src, ext) {
  let s = src.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:\\])\/\/.*$/gm, '$1');
  if (/^(py|rb)$/.test(ext))
    s = s.replace(/("""|''')[\s\S]*?\1/g, ' ').replace(/(^|\s)#.*$/gm, '$1');
  return s;
}
/** A barrel by content, never by name. */
function isBarrel(code, path) {
  if (/(^|\/)__init__\.py$/.test(path))
    return code
      .split('\n')
      .every((l) => !l.trim() || /^\s*(from\s+\S+\s+import|import\s|__all__)/.test(l));
  const statements = code
    .split(';')
    .map((s) => s.trim().replace(/\s+/g, ' '))
    .filter(Boolean);
  return (
    statements.length > 0 &&
    statements.every((s) => /^export (type )?(\*|\{[^}]*\})( as \w+)? from ['"]/.test(s))
  );
}
/** Root-relative directory of the nearest package manifest above `path`; '' = the repository root. */
const MANIFESTS = [
  'package.json',
  'go.mod',
  'pyproject.toml',
  'setup.py',
  'setup.cfg',
  'Cargo.toml',
  'pom.xml',
  'build.gradle',
  'build.gradle.kts',
  'composer.json',
  'Gemfile',
];
const pkgOfDir = new Map();
function packageOf(path) {
  const dirs = [];
  let found = '';
  for (let dir = posix.dirname(path); dir && dir !== '.'; dir = posix.dirname(dir)) {
    if (pkgOfDir.has(dir)) {
      found = pkgOfDir.get(dir);
      break;
    }
    dirs.push(dir);
    if (MANIFESTS.some((m) => existsSync(join(root, dir, m)))) {
      found = dir;
      break;
    }
  }
  for (const d of dirs) pkgOfDir.set(d, found);
  return found;
}

/** { out: why } = not sampled; else { tier, label, why, score }. */
function classify(f, changed) {
  if (!existsSync(join(root, f)))
    return { out: 'deleted in the change — a revert only brings the file back' };
  if (atBase(f) === null)
    return { out: 'new file — nothing to revert (new code is proven by --mutants)' };
  for (const [re, why] of SAMPLE_OUT) if (re.test(f)) return { out: why };
  let src;
  try {
    src = readFileSync(join(root, f), 'utf8');
  } catch {
    return { out: 'unreadable' };
  }
  if (TESTS_ALLOW.test(src)) return { out: 'tests-allow waiver — no behaviour' };
  const ext = extOf(f);
  const code = stripComments(src, ext);
  if (isBarrel(code, f)) return { out: 'barrel (re-exports only)' };
  if (/^[cm]?tsx?$/.test(ext) && !RUNTIME_DECL.test(code) && /\b(?:interface|type)\s+\w/.test(code))
    return { out: 'types only' };
  const markup = /^(tsx|jsx|vue|svelte)$/.test(ext);
  const hooks = tally(HOOK_CALL, code);
  const stmt = tally(/^(py|go|rb)$/.test(ext) ? STMT_WORDS : STMT_JS, code);
  const expr = tally(EXPR_BRANCH, code);
  // Conditional rendering alone (`a && <X/>`, `a ? <X/> : null`) is markup; a hook or a statement is logic.
  if (markup && !hooks && !stmt && expr <= 3) return { out: 'markup without logic' };
  const kind = SAMPLE_TIERS.find(([re]) => re.test(f))?.[1];
  if (!markup && !tally(FUNC, code) && kind !== VALIDATION)
    return { out: 'data without functions (constants)' };
  const logic = hooks + stmt + expr;
  const pick = (tier, label) => ({
    tier,
    label,
    why: `${changed} changed lines · logic ${logic}`,
    score: changed + logic,
  });
  if (kind) return pick(1, kind);
  if (!markup) return pick(2, 'logic');
  return PAGE.test(f) ? pick(3, 'page with logic') : pick(4, 'component with logic');
}

function criticalSample(list, tail) {
  if (!list.length) return list;
  const changed = new Map();
  for (const line of (git(['diff', '--numstat', '--no-renames', base]).stdout || '').split('\n')) {
    const [a, d, p] = line.split('\t');
    if (p) changed.set(p.trim(), (Number(a) || 0) + (Number(d) || 0));
  }
  const byPkg = new Map();
  const left = new Map(); // why → files
  const leave = (why, f) => left.set(why, [...(left.get(why) ?? []), f]);
  for (const f of list) {
    let c = classify(f, changed.get(f) ?? 0);
    // --all judges every file; the classification only ranks it (a non-critical kind goes last, named).
    if (c.out && ALL)
      c = {
        tier: 5,
        label: `not a critical kind: ${c.out}`,
        why: `${changed.get(f) ?? 0} changed lines`,
        score: changed.get(f) ?? 0,
      };
    if (c.out) leave(c.out, f);
    else {
      const pkg = packageOf(f);
      byPkg.set(pkg, [...(byPkg.get(pkg) ?? []), { f, ...c }]);
    }
  }
  const chosen = [];
  for (const pkg of [...byPkg.keys()].sort()) {
    const ranked = byPkg
      .get(pkg)
      .sort((x, y) => x.tier - y.tier || y.score - x.score || (x.f < y.f ? -1 : x.f > y.f ? 1 : 0));
    chosen.push(...ranked.slice(0, MAX));
    for (const x of ranked.slice(MAX)) leave(`over --max ${MAX} per package`, x.f);
  }
  process.stdout.write(
    ALL
      ? `mustfail · every changed file with behaviour (--all): ${chosen.length}, most critical first\n`
      : `mustfail · critical files: ${chosen.length} of ${list.length} changed with behaviour` +
          `${MAX_SET ? ` (at most ${MAX} per package)` : ''} — the limit is not a file count but a budget of ${BUDGET_MS / 60_000} min per package ` +
          `(all: --all, your own list: --files)\n`,
  );
  for (const x of chosen) process.stdout.write(`  + ${x.f} — ${x.label} · ${x.why}\n`);
  for (const [why, fs] of left)
    process.stdout.write(
      `  − ${why}: ${fs.slice(0, 8).join(', ')}${fs.length > 8 ? ` … ${fs.length - 8} more` : ''}\n`,
    );
  process.stdout.write(`  · ${tail}\n`);
  return chosen.map((x) => x.f);
}

const files = targets();
if (!files.length) {
  console.error(
    `mustfail: no behaviour-bearing changed source files against ${base} — nothing to prove` +
      (flag('files') || ALL
        ? ''
        : ' (the sample above left none; --all judges every changed file, --files names them)'),
  );
  process.exit(2);
}

// ---- the runner that takes a list of test files --------------------------------------------------------
// Selection needs a command that runs exactly the picked test files. {tests} in --cmd says where they go, for
// any runner. Without it vitest and jest are recognised — named in --cmd, or as the body of the package.json
// script --cmd runs — and rebuilt as `<runner> run <tests>`: the placeholders, positional filters, coverage,
// watch and changed-only flags are dropped (coverage thresholds fail on any subset), the rest is kept. A chain
// (`a && b`), an unknown runner or `vitest bench` → null: the legacy modes run --cmd as written.
function shellSplit(s) {
  const out = [];
  let cur = '';
  let quote = null;
  let started = false;
  for (const ch of s) {
    if (quote) {
      if (ch === quote) quote = null;
      else cur += ch;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
      started = true;
    } else if (/\s/.test(ch)) {
      if (cur || started) out.push(cur);
      cur = '';
      started = false;
    } else cur += ch;
  }
  if (cur || started) out.push(cur);
  return out;
}
const shq = (t) => (t === '' || /[\s"'`$&|;<>()]/.test(t) ? `"${t.replace(/"/g, '\\"')}"` : t);
// The runner's own binary only: `node vitest.cjs` (this tool's fixture fakes) is somebody's script, not vitest.
const isRunner = (t) =>
  /^(?:vitest|jest)(?:\.cmd)?$/i.test(posix.basename(t.replace(/\\/g, '/'))) ||
  /(?:^|\/)node_modules\/(?:vitest\/vitest\.mjs|jest\/bin\/jest\.js)$/i.test(t.replace(/\\/g, '/'));
const RUNNER_ARGS = {
  vitest: {
    value: new Set([
      '-c',
      '--config',
      '-r',
      '--root',
      '--dir',
      '--project',
      '--environment',
      '--pool',
      '--reporter',
      '--outputFile',
      '-t',
      '--testNamePattern',
      '--mode',
      '--maxWorkers',
      '--minWorkers',
      '--testTimeout',
      '--hookTimeout',
      '--retry',
      '--bail',
    ]),
    drop: /^(?:--coverage(?:\..*)?|--watch|-w|--run|--changed|--shard|--ui|--open|--related)$/,
  },
  jest: {
    value: new Set([
      '-c',
      '--config',
      '--rootDir',
      '-t',
      '--testNamePattern',
      '-w',
      '--maxWorkers',
      '--testTimeout',
      '--reporters',
      '--env',
      '--testEnvironment',
      '--selectProjects',
    ]),
    drop: /^(?:--coverage|--collectCoverage|--watch|--watchAll|--onlyChanged|-o|--lastCommit|--findRelatedTests|--runTestsByPath|--listTests|--changedSince|--testPathPatterns?|--shard)$/,
  },
};
function testRunner() {
  if (CMD.includes('{tests}'))
    return { label: CMD, build: (list) => CMD.replaceAll('{tests}', list) };
  let inv = CMD.trim();
  let viaScript = false;
  for (let hop = 0; hop < 3; hop++) {
    const m =
      /^(?:npm|pnpm|yarn|bun)\s+(?:run(?:-script)?\s+)?(?!(?:exec|x|dlx)\s)([\w:.@/-]+)(.*)$/s.exec(
        inv,
      );
    if (!m) break;
    let scripts = {};
    try {
      scripts = JSON.parse(readFileSync(join(CWD, 'package.json'), 'utf8')).scripts ?? {};
    } catch {
      /* no package.json: nothing to resolve */
    }
    const extra = m[2].replace(/^\s+--(?=\s|$)/, '');
    if (typeof scripts[m[1]] === 'string') {
      inv = `${scripts[m[1]]}${extra}`;
      viaScript = true;
    } else if (/^(vitest|jest)$/.test(m[1])) inv = `npx ${m[1]}${extra}`;
    else return null;
  }
  if (/&&|\|\||;|\|/.test(inv)) return null;
  const toks = shellSplit(inv);
  // `node --test a.test.mjs b.test.mjs`: its files are a selection like any other; a fixed list per revert ran
  // every suite for every file (356 s a revert, measured). Flags stay, paths are replaced.
  if (
    /^node(?:\.exe)?$/i.test(posix.basename((toks[0] ?? '').replace(/\\/g, '/'))) &&
    toks.includes('--test')
  ) {
    const value = new Set([
      '--test-reporter',
      '--test-reporter-destination',
      '--test-name-pattern',
      '--test-skip-pattern',
      '--test-concurrency',
      '--test-timeout',
      '--import',
      '--require',
      '-r',
      '--loader',
      '--env-file',
      '--conditions',
      '-C',
    ]);
    const keep = [];
    for (let i = 1; i < toks.length; i++) {
      const a = toks[i];
      if (!a.startsWith('-') || /^--test-shard\b|^--watch\b/.test(a)) continue;
      keep.push(a);
      if (!a.includes('=') && value.has(a) && i + 1 < toks.length) keep.push(toks[++i]);
    }
    const cmd = [toks[0], ...keep].map(shq).join(' ');
    // node has no include/exclude config and its TAP names tests, not files: «never mentioned» means nothing here.
    return { label: `${cmd} <tests>`, build: (list) => `${cmd} ${list}`, runsEveryPath: true };
  }
  const at = toks.findIndex(isRunner);
  if (at < 0) return null;
  const kind = /jest/i.test(posix.basename(toks[at].replace(/\\/g, '/'))) ? 'jest' : 'vitest';
  const head = toks.slice(0, at + 1);
  // A script body's bare `vitest` is found through node_modules/.bin under `npm run`; outside it npx finds it.
  if (viaScript && at === 0) head.unshift('npx');
  const args = toks.slice(at + 1);
  const { value, drop } = RUNNER_ARGS[kind];
  const keep = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (kind === 'vitest' && i === 0 && a === 'bench') return null;
    if (kind === 'vitest' && i === 0 && /^(?:run|related|watch|dev)$/.test(a)) continue;
    if (!a.startsWith('-')) continue; // a filter, a test path, {file}: the selection replaces them all
    const name = a.split('=')[0];
    if (drop.test(name)) continue;
    keep.push(a);
    if (!a.includes('=') && value.has(name) && i + 1 < args.length) keep.push(args[++i]);
  }
  const cmd = [
    ...head,
    ...(kind === 'vitest' ? ['run'] : []),
    ...keep,
    ...(kind === 'jest' ? ['--runTestsByPath'] : []),
  ]
    .map(shq)
    .join(' ');
  // A revert run needs ONE failure for its verdict: the runner stops there instead of finishing every picked file.
  // The baseline runs without it — it must name every test file that is already red.
  const bail = keep.some((a) => /^--bail\b/.test(a))
    ? ''
    : kind === 'vitest'
      ? ' --bail=1'
      : ' --bail';
  return {
    label: `${cmd} <tests>`,
    build: (list, stopAtFirst = false) => `${cmd}${stopAtFirst ? bail : ''} ${list}`,
  };
}
const RUNNER = testRunner();
const SELECT = Boolean(RUNNER) && !has('no-select') && !has('no-graph') && !has('no-sibling');

// ---- verdict memo (verify-ledger design §3, row «mustfail»: S1 per-file verdict memo) ---------------
// The ledger replays a check at an identical tree, but mustfail MUTATES the tree, so no run of it ever
// meets its own key — the proof was redone from scratch on every stage, review and resume (measured:
// mustfail twice over the same tree, ~13 min each). A verdict is a fact about (tree, base, command,
// file): any byte of the tree changes the key (the test closure is the whole tree). Stored beside the
// journal, per worktree. `--fresh` ignores it. A budget-cut run resumes here: judged files stay judged.
function treeKey() {
  const idx = join(STATE, `idx-${process.pid}`);
  try {
    mkdirSync(STATE, { recursive: true });
    const real = resolve(CWD, git(['rev-parse', '--git-path', 'index']).stdout.trim());
    if (existsSync(real)) copyFileSync(real, idx);
    const env = { ...process.env, GIT_INDEX_FILE: idx };
    if (git(['-c', 'core.autocrlf=false', 'add', '-A', '--', ':/'], { env }).status !== 0)
      return null;
    return git(['write-tree'], { env }).stdout.trim() || null;
  } catch {
    return null;
  } finally {
    rmSync(idx, { force: true });
  }
}
const MEMO = join(STATE, 'memo');
const TREE = QUICK || has('fresh') ? null : treeKey();
// Selection changes what a verdict is about (the picked tests, not the whole --cmd): its own key; legacy keys stay.
const memoFile = (f) =>
  join(
    MEMO,
    `${sha(Buffer.from(JSON.stringify(SELECT ? [TREE, base, CMD, f, 'select', GRAPH_CAP] : [TREE, base, CMD, f])))}.json`,
  );
// A RED is a fact about (tree, base, file) whatever command proved it — some test of this tree notices the
// revert: proven and unchanged is never re-run (a changed --cmd string re-ran a proven file).
// GREEN / NO-BASE stay keyed by the command: a different selection may catch what this one missed.
const redFile = (f) =>
  join(MEMO, `${sha(Buffer.from(JSON.stringify([TREE, base, f, 'red-any-cmd'])))}.json`);
const MEMOABLE = new Set(['RED', 'RED·symbol', 'GREEN', 'NO-BASE']);
function remember(f, verdict, note) {
  if (!TREE || !MEMOABLE.has(verdict)) return;
  try {
    mkdirSync(MEMO, { recursive: true });
    // Local wall-clock time: the stamp is printed to a human, and UTC read as local was hours off.
    const rec = JSON.stringify({
      verdict,
      note,
      at: new Date().toLocaleString('sv-SE').slice(0, 16),
    });
    writeFileSync(memoFile(f), rec);
    if (verdict === 'RED') writeFileSync(redFile(f), rec);
  } catch {
    /* a memo that cannot be written only costs the next run time */
  }
}
const rows = [];
if (TREE) {
  for (const f of [...files]) {
    const hit = [memoFile(f), redFile(f)].find((p) => existsSync(p));
    if (!hit) continue; // not judged at this tree yet
    try {
      const m = JSON.parse(readFileSync(hit, 'utf8'));
      const other = hit !== memoFile(f) ? ', another command' : '';
      rows.push([f, m.verdict, `${m.note} (verdict from ${m.at}, same tree${other})`]);
      files.splice(files.indexOf(f), 1);
    } catch {
      /* an unreadable memo only costs a run */
    }
  }
  if (rows.length)
    process.stdout.write(
      `mustfail: ${rows.length} file(s) already proven at this very tree — no run\n`,
    );
}

/** Content of a path at the base revision, or null when the file did not exist there. */
function atBase(path) {
  const r = git(['show', `${base}:${path}`], { encoding: 'buffer' });
  return r.status === 0 ? r.stdout : null;
}

const TEMPLATED = /\{file\}|\{abs\}/.test(CMD);
const cmdFor = (path) =>
  CMD.replaceAll('{file}', posix.relative(PREFIX || '.', path)).replaceAll(
    '{abs}',
    join(root, path),
  );
// Runners that take many files at once and say so when a file has no test. For them the per-file
// baselines collapse into ONE run over every file (a green union means no file's related tests fail),
// and the only other reason a narrowed run is red — no test for that file — is read from the output.
// Measured: 16 files × (own baseline + revert) × ~50 s = 26 min; this halves it.
const MULTI_FILE = /\b(vitest|jest|pytest)\b/i;
const NO_TESTS = /No test files found|No tests found|no tests ran|collected 0 items/i;
const cmdForMany = (paths) =>
  CMD.replaceAll('{file}', paths.map((p) => posix.relative(PREFIX || '.', p)).join(' ')).replaceAll(
    '{abs}',
    paths.map((p) => join(root, p)).join(' '),
  );
let spent = 0;

/**
 * The check exited 0 without running a single test (g9 25.10: `--cmd "npx vitest run {file}"` on source files,
 * under a config with passWithNoTests — «green» baseline, every file then «NOT covered», 13 s for a false
 * verdict, then the slow graph run). Nothing is reverted yet: stop with the command that does run tests.
 */
function stopNoTests(out) {
  try {
    restore();
  } catch {
    /* called before the first save (the restore state is not set up yet): nothing to put back */
  }
  const tail = String(out || '')
    .split('\n')
    .filter(Boolean)
    .slice(-6)
    .join('\n');
  console.error(
    `\nmustfail: the check ran NO test at all and exited 0 — a green run without a test proves nothing, and every revert would read «NOT covered». ` +
      'With {file} that means it names the source file, not its test (a runner config with passWithNoTests turns «no test files» into exit 0). ' +
      'Use --cmd "npx vitest run" or the package test script (vitest/jest: each file runs only its @covers / sibling / directory tests), ' +
      '"<runner> {tests}" for any other runner; the legacy form "npx vitest related {file} --run" walks the import graph per file.\n' +
      `${tail}`,
  );
  process.exit(2);
}
// A related-tests command already asks the runner for the file's tests: «none» there is a real answer
// (the file has no test — NO-BASE row), not a wrong --cmd.
const RELATED_CMD = /\brelated\s+\{file\}|--findRelatedTests\b/.test(CMD);
const noTests = (r) =>
  !RELATED_CMD && r.status === 0 && NO_TESTS.test(`${r.stdout ?? r.out ?? ''}${r.stderr ?? ''}`);

/** The file's own test beside it (`x.tsx` → `x.test.tsx`, `__tests__/x.test.ts`), relative to the top; null if none. */
const TEST_FILE = /\.(?:test|spec)\.[cm]?[jt]sx?$/i;
function siblingTest(path) {
  const m = /^(.*?)([^/]+)\.([cm]?[jt]sx?|vue|svelte)$/i.exec(path);
  if (!m || TEST_FILE.test(path)) return null;
  const [, dir, name, ext] = m;
  const exts = [
    ...new Set(
      [ext, 'ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs', 'mts', 'cts'].filter((e) =>
        /^[cm]?[jt]sx?$/i.test(e),
      ),
    ),
  ];
  for (const kind of ['test', 'spec'])
    for (const e of exts)
      for (const cand of [`${dir}${name}.${kind}.${e}`, `${dir}__tests__/${name}.${kind}.${e}`])
        if (existsSync(join(root, cand))) return cand;
  return null;
}

const run = (path = null, command = null) => {
  const started = Date.now();
  const r = spawnSync(command ?? (path && TEMPLATED ? cmdFor(path) : CMD), {
    cwd: CWD,
    shell: SHELL,
    encoding: 'utf8',
    maxBuffer: 64 << 20,
  });
  spent += Date.now() - started;
  return r;
};
// ---- known-red baseline ------------------------------------------------------------------------
// A check red before any revert (an environment-bound test: no remote, no neighbour worktree) used to stop
// the run or make the file NO-BASE, which pushed the caller into a hand-made skip wrapper that bypassed {tests}
// selection (7 suites per revert, 356 s each, measured). When the runner names its failing tests, that set IS
// the baseline: a revert is RED only when it fails a test outside it, or dies naming none.
const FAIL_LINE = [
  /^\s*not ok \d+ - (.+?)(?:\s+#\s.*)?$/, // TAP: node --test, tape
  /^\s*--- FAIL: (\S+)/, // go test -v
  /^FAILED (\S+)/, // pytest -rf
  /^\s*FAIL\s+(\S+\s+>\s+.+?)\s*$/, // vitest / jest summary: FAIL file > suite > name
  /^\s*[×✕✗]\s+(.+?)(?:\s+\d+\s?ms)?\s*$/, // vitest / jest per test
  /^\s*✖\s+(.+?)(?:\s+\(\d+(?:\.\d+)?m?s\))?\s*$/, // node --test spec reporter (a TTY default)
];
/** Names of the failing tests a run printed; null when it printed none (crash, load error, unknown runner). */
function failedTests(out) {
  const ids = new Set();
  for (const line of String(out ?? '').split('\n'))
    for (const re of FAIL_LINE) {
      const m = re.exec(line);
      if (m) {
        ids.add(m[1].trim());
        break;
      }
    }
  return ids.size ? ids : null;
}
const outOf = (r) => `${r.stdout ?? r.out ?? ''}\n${r.stderr ?? ''}`;
/** Red against a known-red baseline: a failing test outside it, or a red run that names none. */
function redVs(r, known) {
  if (r.status === 0) return false;
  if (!known) return true;
  const ids = failedTests(outOf(r));
  return !ids || [...ids].some((id) => !known.has(id));
}
const knownLine = (known) =>
  `${known.size} test(s): ${[...known].slice(0, 3).join(' · ').slice(0, 160)}${known.size > 3 ? ' …' : ''}`;
if (TEMPLATED && QUICK && !SELECT) {
  console.error(
    'mustfail: --quick reverts every file at once — it cannot be combined with a per-file {file} command',
  );
  process.exit(2);
}

// ---- baseline: the check must be green before a mutation means anything -------------------------
process.stdout.write(`mustfail · base ${base} · ${files.length} file(s) · ${CMD}\n`);
// A templated command has no single baseline: each file is measured against its own narrowed run.
// Selection runs its own baseline: the union of the picked tests, never the whole --cmd.
const baseline = SELECT || TEMPLATED || !files.length ? { status: 0 } : run();
const baselineMs = spent;
/** Tests already failing in the whole-check baseline; null = baseline green. */
let KNOWN = null;
if (baseline.status !== 0) {
  KNOWN = failedTests(outOf(baseline));
  if (!KNOWN) {
    const tail = (baseline.stdout || '').split('\n').slice(-12).join('\n');
    console.error(
      `\nmustfail: the check is ALREADY RED before any mutation and names no failing test — fix it first, a red check proves nothing.\n${tail}`,
    );
    process.exit(2);
  }
  process.stdout.write(
    `· the baseline is red before any revert — ${knownLine(KNOWN)}; a revert is RED only on a new failure\n`,
  );
}
if (!SELECT && !TEMPLATED && files.length && noTests(baseline)) stopNoTests(baseline.stdout);

// ---- mutation ------------------------------------------------------------------------------------
/** @type {Map<string, {full: string, before: Buffer|null, backup: string}>} */
const saved = new Map();
let restored = false;

function save(path) {
  const full = join(root, path);
  const before = existsSync(full) ? readFileSync(full) : null;
  const backup = track(full, before);
  saved.set(path, { full, before, backup, wrote: undefined });
}

/**
 * Put one saved file back — only while it still holds the bytes this run wrote (a restore of the
 * plan-time original once erased a parallel agent's edit). Someone's edit stays; its original is kept.
 * @returns false when the file could not be written back
 */
function putFileBack(path) {
  const e = saved.get(path);
  if (e.wrote === undefined) return true; // this run never wrote it
  const now = existsSync(e.full) ? readFileSync(e.full) : null;
  if (now === null || !now.equals(e.wrote)) {
    keepBackups = true;
    e.wrote = undefined;
    console.error(
      `\nmustfail: ${path} CHANGED during the run (someone edited it) — left as is, not restored; the edit may sit on top of the base revert. Original kept in ${e.backup}.`,
    );
    return true;
  }
  // Cleared only after a verified write: a write that throws keeps the record, so restore() in the finally and the
  // next start's settle() still know the file holds base bytes.
  if (e.before === null) {
    if (existsSync(e.full)) unlinkSync(e.full);
    e.wrote = undefined;
    return true;
  }
  writeFileSync(e.full, e.before);
  const ok = readFileSync(e.full).equals(e.before);
  if (ok) e.wrote = undefined;
  return ok;
}

function restore() {
  if (restored) return true;
  restored = true;
  const broken = [];
  for (const path of saved.keys()) {
    try {
      if (!putFileBack(path)) broken.push(path);
    } catch {
      broken.push(path);
    }
  }
  if (broken.length) {
    console.error(
      `\nmustfail: COULD NOT RESTORE ${broken.join(', ')} — originals are in ${BACKUPS} (journal ${JOURNAL})`,
    );
    return false;
  }
  closeJournal();
  return true;
}

for (const sig of SIGNALS) {
  process.on(sig, () => {
    restore();
    process.exit(2);
  });
}

/** Revert one path to base. @returns 'reverted' | 'new' (did not exist at base) */
function revert(path) {
  const e = saved.get(path);
  const content = atBase(path);
  if (content === null) return 'new';
  intend(e.full, content);
  mkdirSync(dirname(e.full), { recursive: true });
  e.wrote = content;
  writeFileSync(e.full, content);
  return 'reverted';
}

let exitCode = 0;

// Vitest narrowed by `related {file}`: one graph run instead of a spawn per file (see graphMode).
const GRAPH =
  !SELECT &&
  TEMPLATED &&
  /\bvitest\b/.test(CMD) &&
  /\brelated\s+\{file\}/.test(CMD) &&
  !has('no-graph');

/**
 * Graph mode (measured: 118–177 s per `vitest related {file}`, 22 files ≈ 45 min).
 * 1. Baseline over ALL files at once with mustfail-graph-reporter: green check + the module graph
 *    «which test files reach which target» — vitest's own watcher walk. `--trust-green` skips it.
 * 2. ONE run with every file reverted. Per file: no related test → NO-BASE; none of its related tests
 *    failed → GREEN; a failed test reached by THIS file alone → RED.
 * 3. Only a file whose failures are all shared with other reverted files gets its own run: revert it
 *    alone, run just those failed test files by name (no `related` graph walk). Past --budget these are
 *    printed «UNCHECKED» and never block. Runs bypass the verify ledger: a replay skips the reporter.
 */
/**
 * Env for a mutant run: the ledger off and the panel's lock lifted (a replayed green on a mutated
 * tree would read as "not covered"). The lock also lives in the entry path the panel puts in
 * NODE_OPTIONS (`bin/preload-locked.cjs`), so that entry is swapped back to the plain one.
 */
function unlockedLedgerEnv() {
  const env = { AGENTDECK_VERIFY_LEDGER: 'off', AGENTDECK_VERIFY_LEDGER_LOCK: '' };
  const options = process.env.NODE_OPTIONS ?? '';
  if (options.includes('/bin/preload-locked.cjs"'))
    env.NODE_OPTIONS = options.replace('/bin/preload-locked.cjs"', '/bin/preload.cjs"');
  return env;
}

async function graphMode() {
  const started = Date.now();
  const left = () => BUDGET_MS - (Date.now() - started);
  const reporter = fileURLToPath(new URL('./mustfail-graph-reporter.mjs', import.meta.url)).replace(
    /\\/g,
    '/',
  );
  const graphOut = join(STATE, `graph-${process.pid}.json`);
  const abs = (p) => join(root, p).replace(/\\/g, '/');
  // The panel's lock is lifted for mutant runs only (unlockedLedgerEnv).
  const env = { MUSTFAIL_GRAPH_OUT: graphOut, ...unlockedLedgerEnv() };
  const graphRun = async (label, targets) => {
    mkdirSync(STATE, { recursive: true });
    rmSync(graphOut, { force: true });
    env.MUSTFAIL_TARGETS = JSON.stringify(targets.map(abs));
    const r = await execTree(
      `${cmdForMany(targets)} --reporter=default --reporter="${reporter}"`,
      Math.max(left(), 60_000),
      env,
    );
    spent += r.ms;
    let g = null;
    try {
      g = JSON.parse(readFileSync(graphOut, 'utf8'));
    } catch {
      /* no graph: the reporter never ran (crash before the run, or an old vitest) */
    }
    rmSync(graphOut, { force: true });
    const state = r.timedOut ? 'cut by budget' : r.status === 0 ? 'green' : 'red';
    process.stdout.write(
      `· ${label}: ${state}, test files ${g ? g.tests.length : '?'} (${Math.round(r.ms / 1000)} s)\n`,
    );
    return { r, g };
  };
  const unchecked = (list, why) => list.forEach((f) => rows.push([f, 'UNCHECKED', why]));
  const redKind = (texts) => (texts.every((t) => SYMBOL_RED.test(t)) ? 'RED·symbol' : 'RED');
  const RED_NOTE = {
    RED: 'the revert breaks the check — covered',
    'RED·symbol': 'the import of a vanished symbol failed, not a behaviour check',
  };

  const putBack = (f) => putFileBack(f);

  // Own sibling test first (g9 25.10: the graph walk took 105 s + 102 s for 2 files whose 6 test files run
  // directly in ~10 s). Revert one file, run only its `<name>.test.<ext>`: red = covered, proven without the
  // graph. Green proves nothing yet (another test may cover it) — that file goes on to the graph with the rest.
  // More files than --max with a sibling: the graph's flat two runs are cheaper than a run per file.
  const directMs = [];
  let targets = files;
  const direct = has('no-sibling')
    ? []
    : files.map((f) => [f, siblingTest(f)]).filter(([, t]) => t);
  if (direct.length && direct.length <= (MAX_SET ? MAX : 6)) {
    // Relative like {file}: an absolute path from git's long root misses a runner started under an 8.3 short cwd.
    const viaTests = (list) =>
      CMD.replace(
        /\brelated\s+\{file\}/,
        list.map((t) => `"${posix.relative(PREFIX || '.', t)}"`).join(' '),
      );
    let usable = true;
    if (!TRUST_GREEN) {
      const b = await execTree(
        viaTests(direct.map(([, t]) => t)),
        Math.max(left(), 60_000),
        unlockedLedgerEnv(),
      );
      spent += b.ms;
      usable = !b.timedOut && b.status === 0 && !NO_TESTS.test(b.out);
      process.stdout.write(
        `· own sibling tests: ${direct.length} file(s), baseline ${usable ? 'green' : 'not green — the graph decides'} (${Math.round(b.ms / 1000)} s)\n`,
      );
    }
    const proven = new Set();
    for (const [i, [f, t]] of (usable ? direct : []).entries()) {
      if (left() < 30_000) break;
      save(f);
      if (revert(f) === 'new') {
        putBack(f);
        continue;
      }
      const own = await execTree(viaTests([t]), left(), unlockedLedgerEnv());
      putBack(f);
      spent += own.ms;
      directMs.push(own.ms);
      if (!own.timedOut && own.status !== 0) {
        const kind = redKind([own.out]);
        rows.push([f, kind, `${RED_NOTE[kind]} (own test ${t})`]);
        proven.add(f);
      }
      process.stdout.write(
        `[${i + 1}/${direct.length}] ${f} → ${proven.has(f) ? rows.at(-1)[1] : 'own test green — the graph decides'} (${Math.round(own.ms / 1000)} s)\n`,
      );
    }
    targets = files.filter((f) => !proven.has(f));
    if (!targets.length) return;
  }
  const slowGraph = (ms) => {
    const one = directMs.length
      ? [...directMs].sort((a, b) => a - b)[Math.floor(directMs.length / 2)]
      : 0;
    if (one && ms > 10 * one)
      process.stdout.write(
        `· graph walk ${Math.round(ms / 1000)} s against ≈${Math.round(one / 1000)} s for a direct run of an own test (>10×): a test beside the file, or test files named in --cmd, is cheaper\n`,
      );
  };

  let graph = null;
  const baseFailed = new Set();
  if (!TRUST_GREEN) {
    const { r, g } = await graphRun('baseline with graph', targets);
    slowGraph(r.ms);
    if (!g || r.timedOut) {
      process.stdout.write(`${(r.out || '').split('\n').slice(-15).join('\n')}\n`);
      return unchecked(targets, 'the baseline produced no graph — rerun with --no-graph');
    }
    for (const t of g.tests) if (t.failed) baseFailed.add(t.file);
    graph = g.related;
  }

  const reverted = [];
  for (const f of targets) {
    save(f);
    if (revert(f) === 'new')
      rows.push([f, 'SKIP', 'new file — reverting it breaks the build, not a coverage signal']);
    else reverted.push(f);
  }
  if (!reverted.length) return targets.forEach(putBack);
  const { r, g } = await graphRun('all files reverted at once', reverted);
  targets.forEach(putBack);
  if (!g || r.timedOut) {
    process.stdout.write(`${(r.out || '').split('\n').slice(-15).join('\n')}\n`);
    return unchecked(reverted, 'the reverted run produced no graph or was cut by budget');
  }
  graph ??= g.related;
  const failed = new Map(
    g.tests.filter((t) => t.failed && !baseFailed.has(t.file)).map((t) => [t.file, t.text || '']),
  );
  const related = (f) => (graph[abs(f)] ?? []).filter((t) => !baseFailed.has(t));
  const owners = new Map();
  for (const f of reverted)
    for (const t of related(f)) owners.set(t, [...(owners.get(t) ?? []), f]);

  const tieBreak = [];
  for (const f of reverted) {
    const mine = related(f);
    if (!mine.length) {
      const why = (graph[abs(f)] ?? []).length
        ? 'every related test fails before the revert'
        : 'no related tests';
      rows.push([f, 'NO-BASE', why]);
      continue;
    }
    const hit = mine.filter((t) => failed.has(t));
    if (!hit.length)
      rows.push([
        f,
        'GREEN',
        `the revert does not break the check — NOT covered (related test files: ${mine.length})`,
      ]);
    else if (hit.some((t) => owners.get(t).length === 1)) {
      const kind = redKind(hit.filter((t) => owners.get(t).length === 1).map((t) => failed.get(t)));
      rows.push([f, kind, RED_NOTE[kind]]);
    } else tieBreak.push([f, hit]);
  }

  // Shared failures only: which of the reverted files broke them is unknown — one narrow run each.
  for (const [i, [f, hit]] of tieBreak.entries()) {
    if (left() < 30_000) {
      unchecked(
        [f],
        `--budget ${BUDGET_MS / 60_000} min spent — run again, proven files are not repeated`,
      );
      continue;
    }
    // The runner's own absolute ids: a path re-derived against --cwd breaks on an 8.3 short spelling.
    const tests = hit.map((t) => `"${t}"`).join(' ');
    revert(f);
    const own = await execTree(
      CMD.replace(/\brelated\s+\{file\}/, tests),
      left(),
      unlockedLedgerEnv(),
    );
    putBack(f);
    spent += own.ms;
    if (own.timedOut) unchecked([f], 'own run cut by budget');
    else if (own.status === 0)
      rows.push([
        f,
        'GREEN',
        'the revert alone does not break the check — NOT covered (failed only together with others)',
      ]);
    else {
      const kind = redKind([own.out]);
      rows.push([f, kind, RED_NOTE[kind]]);
    }
    process.stdout.write(
      `[${i + 1}/${tieBreak.length}] ${f} → ${rows.at(-1)[1]} (${Math.round(own.ms / 1000)} s)\n`,
    );
  }
}

// ---- test selection: each reverted file runs only the tests that cover it ----------------------------
// Order, cheapest exact first: `@covers` claims (a project coverage contract) + the sibling test → the tests
// of the file's own directory (those importing it first) → the static import graph, nearest by path. Never
// the whole suite: a file without any test is GREEN «not covered» without a run.
const SPEC = /(?:^|\/)(?:[^/]+[._-](?:test|spec)\.[cm]?[jt]sx?|test_[^/]+\.py|[^/]+_test\.py)$/i;
const cmpStr = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
let repoSet = null;
/** Every file of the tree (tracked + untracked, not ignored, not deleted), root-relative. */
function repoFiles() {
  if (repoSet) return repoSet;
  const z = (args) => (git(args, { cwd: root }).stdout || '').split('\0').filter(Boolean);
  const gone = new Set(z(['ls-files', '-z', '--deleted']));
  repoSet = new Set(
    z(['ls-files', '-z', '--cached', '--others', '--exclude-standard']).filter(
      (f) => !gone.has(f) && !/(^|\/)node_modules\//.test(f),
    ),
  );
  return repoSet;
}
const testsByPkg = new Map();
function testsOf(pkg) {
  if (!testsByPkg.has(pkg)) {
    const pre = pkg ? `${pkg}/` : '';
    testsByPkg.set(
      pkg,
      [...repoFiles()].filter((f) => f.startsWith(pre) && SPEC.test(f) && packageOf(f) === pkg),
    );
  }
  return testsByPkg.get(pkg);
}

// Same reading as a project coverage checker (parseCovers / coversBase), not imported: a claim is a
// path from <pkg>/src, or from the package root when it starts with src/, plugins/ or scripts/; a directory
// claim covers the files directly in it, never the subtree.
const COVERS_ROOTS = ['src', 'plugins', 'scripts'];
const coversByPkg = new Map();
function claimTargets(pkg, claim) {
  const at = (...parts) => posix.normalize(parts.filter(Boolean).join('/'));
  return [
    ...new Set([
      at(pkg, COVERS_ROOTS.includes(claim.split('/')[0]) ? '' : 'src', claim),
      at(pkg, claim),
      at(claim),
    ]),
  ];
}
function coversIndex(pkg) {
  if (coversByPkg.has(pkg)) return coversByPkg.get(pkg);
  const idx = new Map(); // claimed root-relative file or directory → test files
  for (const t of testsOf(pkg)) {
    let src;
    try {
      src = readFileSync(join(root, t), 'utf8');
    } catch {
      continue;
    }
    for (const m of src.matchAll(/@covers\s+([^\s*]+)/g)) {
      const claim = m[1]
        .replace(/^[`'"]+|[`'",;.]+$/g, '')
        .replace(/^\.\//, '')
        .replace(/\/+$/, '');
      if (!claim) continue;
      for (const target of claimTargets(pkg, claim)) {
        if (!idx.has(target)) idx.set(target, new Set());
        idx.get(target).add(t);
      }
    }
  }
  coversByPkg.set(pkg, idx);
  return idx;
}
function coveringTests(f) {
  const idx = coversIndex(packageOf(f));
  return [...new Set([...(idx.get(f) ?? []), ...(idx.get(posix.dirname(f)) ?? [])])].sort(cmpStr);
}
function pySibling(f) {
  const m = /^(.*?)([^/]+)\.py$/.exec(f);
  if (!m || SPEC.test(f)) return null;
  const [, dir, name] = m;
  const files = repoFiles();
  for (const c of [
    `${dir}test_${name}.py`,
    `${dir}${name}_test.py`,
    `${dir}tests/test_${name}.py`,
    `${dir}../tests/test_${name}.py`,
  ])
    if (files.has(posix.normalize(c))) return posix.normalize(c);
  return null;
}
const ownDirs = (f) => {
  const d = posix.dirname(f);
  return new Set([d, `${d}/__tests__`, `${d}/tests`, `${d}/test`]);
};

/** A JSON-with-comments file (tsconfig): comments stripped outside strings, trailing commas dropped. */
function readJsonc(p) {
  let s;
  try {
    s = readFileSync(p, 'utf8');
  } catch {
    return null;
  }
  let out = '';
  for (let i = 0, q = false; i < s.length; i++) {
    const c = s[i];
    if (q) {
      out += c;
      if (c === '\\') out += s[++i] ?? '';
      else if (c === '"') q = false;
    } else if (c === '"') {
      q = true;
      out += c;
    } else if (c === '/' && s[i + 1] === '/') {
      while (i < s.length && s[i] !== '\n') i++;
      out += '\n';
    } else if (c === '/' && s[i + 1] === '*') {
      const end = s.indexOf('*/', i + 2);
      if (end < 0) break;
      i = end + 1;
    } else out += c;
  }
  try {
    return JSON.parse(out.replace(/,(\s*[}\]])/g, '$1'));
  } catch {
    return null;
  }
}
/** Import aliases of a package: tsconfig `paths`, then vite/vitest `resolve.alias` written as resolve(__dirname, …). */
function aliasesOf(pkg) {
  const out = [];
  const add = (key, target) => {
    const k = key.replace(/\/?\*$/, '').replace(/\/$/, '');
    if (k && !out.some((a) => a.key === k))
      out.push({ key: k, target: posix.normalize(target.replace(/\/?\*$/, '')) });
  };
  const dir = pkg || '.';
  for (const name of [
    'tsconfig.json',
    'tsconfig.app.json',
    'tsconfig.base.json',
    'jsconfig.json',
  ]) {
    const co = readJsonc(join(root, dir, name))?.compilerOptions;
    if (!co?.paths) continue;
    for (const [k, v] of Object.entries(co.paths))
      if (Array.isArray(v) && typeof v[0] === 'string')
        add(k, posix.join(dir, co.baseUrl ?? '.', v[0]));
  }
  for (const name of ['vite.config', 'vitest.config'].flatMap((n) =>
    ['ts', 'mts', 'js', 'mjs'].map((e) => `${n}.${e}`),
  )) {
    let s;
    try {
      s = readFileSync(join(root, dir, name), 'utf8');
    } catch {
      continue;
    }
    for (const m of s.matchAll(
      /['"]([^'"\s]+)['"]\s*:\s*(?:path\.)?resolve\(\s*__dirname\s*,\s*['"]([^'"]+)['"]\s*\)/g,
    ))
      add(m[1], posix.join(dir, m[2]));
    for (const m of s.matchAll(
      /['"]([^'"\s]+)['"]\s*:\s*fileURLToPath\(\s*new URL\(\s*['"]([^'"]+)['"]\s*,\s*import\.meta\.url\s*\)\s*\)/g,
    ))
      add(m[1], posix.join(dir, m[2]));
  }
  return out.sort((a, b) => b.key.length - a.key.length);
}
const RESOLVE_EXT = [
  '.ts',
  '.tsx',
  '.js',
  '.jsx',
  '.mjs',
  '.cjs',
  '.mts',
  '.cts',
  '.vue',
  '.svelte',
];
function resolveSpec(from, spec, aliases) {
  let p = null;
  if (/^\.\.?(\/|$)/.test(spec)) p = posix.join(posix.dirname(from), spec);
  else {
    const a = aliases.find((x) => spec === x.key || spec.startsWith(`${x.key}/`));
    if (a) p = posix.join(a.target, spec.slice(a.key.length));
  }
  if (!p) return null; // a bare package: outside the tree
  p = posix.normalize(p.replace(/\?.*$/, ''));
  const files = repoFiles();
  const cands = [p, ...RESOLVE_EXT.map((e) => p + e), ...RESOLVE_EXT.map((e) => `${p}/index${e}`)];
  const js = /\.[cm]?jsx?$/.exec(p);
  if (js) cands.push(...['.ts', '.tsx', '.mts', '.cts'].map((e) => p.slice(0, -js[0].length) + e)); // ESM `./x.js` → x.ts
  return cands.find((c) => files.has(c)) ?? null;
}
// Static imports, re-exports, dynamic import() and require(); `import type` is erased before a run, vi.mock is not an edge.
const IMPORT_RE =
  /\b(?:import|export)\s+(type\s+)?(?:[\w$*{}\s,]*?\s*from\s*)?['"]([^'"\n]+)['"]|\bimport\s*\(\s*['"]([^'"\n]+)['"]\s*\)|\brequire\s*\(\s*['"]([^'"\n]+)['"]\s*\)/g;
const revByPkg = new Map();
/** file → the files that import it, inside one package. */
function importers(pkg) {
  if (revByPkg.has(pkg)) return revByPkg.get(pkg);
  const rev = new Map();
  const aliases = aliasesOf(pkg);
  const pre = pkg ? `${pkg}/` : '';
  for (const file of repoFiles()) {
    if (
      !file.startsWith(pre) ||
      !/\.(?:[cm]?[jt]sx?|vue|svelte)$/i.test(file) ||
      /\.d\.ts$|(^|\/)(dist|build|coverage)\//.test(file)
    )
      continue;
    if (packageOf(file) !== pkg) continue;
    let src;
    try {
      src = readFileSync(join(root, file), 'utf8');
    } catch {
      continue;
    }
    for (const m of src.matchAll(IMPORT_RE)) {
      if (m[1]) continue;
      const to = resolveSpec(file, m[2] ?? m[3] ?? m[4], aliases);
      if (!to || to === file) continue;
      if (!rev.has(to)) rev.set(to, new Set());
      rev.get(to).add(file);
    }
  }
  revByPkg.set(pkg, rev);
  return rev;
}
const pathDistance = (a, b) => {
  const x = posix.dirname(a).split('/');
  const y = posix.dirname(b).split('/');
  let i = 0;
  while (i < x.length && i < y.length && x[i] === y[i]) i++;
  return x.length - i + (y.length - i);
};
/** Test files that reach `f` through imports (never walking through another test), nearest by path first. */
function graphTests(f) {
  const rev = importers(packageOf(f));
  const depth = new Map([[f, 0]]);
  const found = [];
  for (const queue = [f]; queue.length;) {
    const cur = queue.shift();
    for (const imp of rev.get(cur) ?? []) {
      if (depth.has(imp)) continue;
      depth.set(imp, depth.get(cur) + 1);
      if (SPEC.test(imp)) found.push(imp);
      else queue.push(imp);
    }
  }
  return found.sort(
    (a, b) =>
      pathDistance(f, a) - pathDistance(f, b) || depth.get(a) - depth.get(b) || cmpStr(a, b),
  );
}
/** { tests, how, capped } — the tests a revert of `f` is judged by. */
function selectTests(f) {
  const inCwd = (t) => !PREFIX || t.startsWith(PREFIX);
  const covers = coveringTests(f).filter(inCwd);
  const sib = [siblingTest(f), pySibling(f)].filter((t) => t && inCwd(t) && repoFiles().has(t));
  const exact = [...new Set([...covers, ...sib])];
  if (exact.length)
    return {
      tests: exact,
      how: covers.length
        ? `@covers ${covers.length}${sib.some((t) => !covers.includes(t)) ? ' + own test' : ''}`
        : 'own test',
    };
  if (GRAPH_CAP <= 0)
    return {
      tests: [],
      how: 'no @covers, no own test (--graph-cap 0: directory and graph not searched)',
    };
  // Own directory first, but only its tests that import the file: a neighbour test that never loads it cannot go
  // red on its revert. The import graph next; a directory test the graph does not connect is the blind last resort
  // (a dynamic import, a glob) and is labelled so.
  const own = ownDirs(f);
  const reach = graphTests(f).filter(inCwd);
  const dir = testsOf(packageOf(f))
    .filter((t) => own.has(posix.dirname(t)) && inCwd(t))
    .sort(cmpStr);
  const ownReach = dir.filter((t) => reach.includes(t));
  if (ownReach.length) {
    const take = ownReach.slice(0, GRAPH_CAP);
    const cut = ownReach.length > take.length;
    return {
      tests: take,
      how: `own directory tests: ${take.length}${cut ? ` of ${ownReach.length}` : ''}`,
      capped: cut,
    };
  }
  if (reach.length) {
    const take = reach.slice(0, GRAPH_CAP);
    const cut = reach.length > take.length;
    return {
      tests: take,
      how: `import graph: ${take.length}${cut ? ` nearest by path of ${reach.length}` : ''}`,
      capped: cut,
    };
  }
  if (dir.length) {
    const take = dir.slice(0, GRAPH_CAP);
    return {
      tests: take,
      how: `own directory tests: ${take.length}${dir.length > take.length ? ` of ${dir.length}` : ''}, none visibly imports the file`,
    };
  }
  return { tests: [], how: 'no tests' };
}

/**
 * Cost of one run of picked tests: t ≈ fixed + perFile × (test files), least squares over every run measured in
 * this package (the baseline is the first point). One distinct size only → half fixed, half per test file: the
 * runner's start-up dominates small runs (measured: 13–30 s for one own-directory run, most of it start-up).
 */
function costModel() {
  const pts = [];
  return {
    add(n, ms) {
      if (n > 0 && ms > 0) pts.push([n, ms]);
    },
    est(n) {
      if (!pts.length) return null;
      const k = pts.length;
      const mx = pts.reduce((s, [x]) => s + x, 0) / k;
      const my = pts.reduce((s, [, y]) => s + y, 0) / k;
      const sxx = pts.reduce((s, [x]) => s + (x - mx) ** 2, 0);
      if (!sxx) return my / 2 + (my / 2) * (n / mx);
      let per = Math.max(0, pts.reduce((s, [x, y]) => s + (x - mx) * (y - my), 0) / sxx);
      let fixed = my - per * mx;
      if (fixed < 0) [fixed, per] = [0, my / mx];
      return fixed + per * n;
    },
  };
}

async function selectMode() {
  process.stdout.write(
    `· test selection: @covers + own test → directory tests → import graph (up to ${GRAPH_CAP} nearest); ` +
      `run: ${RUNNER.label}; budget ${BUDGET_MS / 60_000} min per package\n`,
  );
  const plan = [];
  for (const f of files) {
    if (!existsSync(join(root, f))) {
      rows.push([f, 'SKIP', 'deleted in the change — a revert only brings the file back']);
      continue;
    }
    if (atBase(f) === null) {
      rows.push([f, 'SKIP', 'new file — reverting it breaks the build, not a coverage signal']);
      continue;
    }
    const s = selectTests(f);
    process.stdout.write(`  ${f} ← ${s.how}${s.tests.length ? `: ${shortList(s.tests)}` : ''}\n`);
    if (s.tests.length) plan.push({ f, pkg: packageOf(f), ...s });
    // The import graph is built for JS/TS only: elsewhere «no test found» is a gap of the search, not a verdict.
    else if (/\.(?:[cm]?[jt]sx?|vue|svelte)$/i.test(f))
      rows.push([
        f,
        'GREEN',
        'no tests: no @covers, no own test, no test in the directory, empty import graph — NOT covered, nothing ran',
      ]);
    else
      rows.push([
        f,
        'NO-BASE',
        `no test found: no @covers, no own test, no test in the directory; no import graph is built for .${extOf(f)} — name the tests in --cmd`,
      ]);
  }
  const pkgs = [...new Set(plan.map((p) => p.pkg))];
  for (const pkg of pkgs)
    await judgePackage(
      pkg,
      plan.filter((p) => p.pkg === pkg),
      pkgs.length > 1,
    );
}

const relCwd = (t) => posix.relative(PREFIX || '.', t);
const shortList = (tests) =>
  `${tests.slice(0, 4).map(relCwd).join(', ')}${tests.length > 4 ? ` … ${tests.length - 4} more` : ''}`;
const secs = (ms) => (ms < 10_000 ? Math.round(ms / 100) / 10 : Math.round(ms / 1000));

/** One package: union baseline → cost estimate → per-file reverts in rank order while the estimate fits the budget. */
async function judgePackage(pkg, todo, named) {
  const started = Date.now();
  const left = () => BUDGET_MS - (Date.now() - started);
  const listOf = (tests) => tests.map((t) => `"${relCwd(t)}"`).join(' ');
  const env = unlockedLedgerEnv();
  const model = costModel();
  const budgetCut = (p, why) =>
    rows.push([
      p.f,
      'UNCHECKED',
      `unchecked — budget ${BUDGET_MS / 60_000} min per package: ${why}; re-run — proven files are not repeated`,
    ]);
  const union = [...new Set(todo.flatMap((p) => p.tests))].sort(cmpStr);
  if (named)
    process.stdout.write(
      `· package ${pkg || '(root)'}: ${todo.length} file(s), ${union.length} test file(s)\n`,
    );

  /** Tests failing before any revert, named by the runner; null = green baseline or names unknown. */
  let known = null;

  // Baseline: ONE run of the union of the picked tests, never the whole suite. Memoised per (tree, base, runner):
  // a budget-cut run is resumed, and a resume that re-ran a 342 s baseline spent the budget on it again and cut
  // the same file forever. Any stored baseline whose tests cover this union answers it.
  const baseMemo = TREE
    ? join(MEMO, `${sha(Buffer.from(JSON.stringify([TREE, base, RUNNER.label, 'baseline'])))}.json`)
    : null;
  let stored = [];
  try {
    if (baseMemo) stored = JSON.parse(readFileSync(baseMemo, 'utf8'));
  } catch {
    /* none yet */
  }
  const reuse = stored.find((s) => union.every((t) => s.tests.includes(t)));
  if (!TRUST_GREEN) {
    const b = reuse
      ? { ...reuse, timedOut: false }
      : await execTree(RUNNER.build(listOf(union)), Math.max(left(), 60_000), env);
    if (reuse)
      process.stdout.write(
        `· baseline from the memo: same tree, its tests cover these ${union.length} (${secs(reuse.ms)} s not spent)\n`,
      );
    else spent += b.ms;
    if (b.timedOut)
      return todo.forEach((p) =>
        budgetCut(p, `the baseline over ${union.length} test files did not fit`),
      );
    if (!reuse && baseMemo) {
      // Only what the verdicts read: failing-test lines and the lines naming a picked test file.
      const keep = b.out
        .split('\n')
        .filter(
          (l) => FAIL_LINE.some((re) => re.test(l)) || union.some((t) => l.includes(relCwd(t))),
        )
        .join('\n');
      try {
        mkdirSync(MEMO, { recursive: true });
        writeFileSync(
          baseMemo,
          JSON.stringify(
            [...stored, { tests: union, status: b.status, out: keep, ms: b.ms }].slice(-8),
          ),
        );
      } catch {
        /* a lost memo only costs the next run its baseline */
      }
    }
    if (NO_TESTS.test(b.out)) {
      console.error(
        `\nmustfail: the runner ran none of the ${union.length} picked test file(s) — paths are passed relative to --cwd; check the runner's root/include.\n` +
          `${b.out.split('\n').filter(Boolean).slice(-8).join('\n')}`,
      );
      process.exit(2);
    }
    model.add(union.length, b.ms);
    // A picked test the runner never mentions was filtered out by its config (include/exclude): it proves nothing.
    const mentioned = (t) =>
      b.out.includes(relCwd(t)) || b.out.includes(relCwd(t).replace(/\//g, '\\'));
    const silent =
      !RUNNER.runsEveryPath && union.some(mentioned) ? union.filter((t) => !mentioned(t)) : [];
    const lines = b.out.split('\n');
    // Named failing tests → they are the baseline and every picked file stays in (the red one is often the very
    // file that covers the change); unnamed → the old file-level exclusion.
    known = b.status === 0 ? null : failedTests(b.out);
    const failing =
      b.status === 0 || known
        ? []
        : union.filter((t) =>
            lines.some((l) => l.includes(relCwd(t)) && /\bFAIL\b|×|✕|❯|\bfailed\b/.test(l)),
          );
    if (known)
      process.stdout.write(
        `· the baseline is red before any revert — ${knownLine(known)}; RED only on a new failure\n`,
      );
    if (b.status !== 0 && !known && !failing.length) {
      console.error(
        `\nmustfail: the picked tests are ALREADY RED before any revert, and no failing test file could be named — fix it first.\n${lines.slice(-15).join('\n')}`,
      );
      process.exit(2);
    }
    process.stdout.write(
      `· baseline: ${union.length} test file(s) — ${failing.length ? `red, failing before the revert: ${shortList(failing)} (excluded)` : 'green'}` +
        `${silent.length ? ` · the runner did not run: ${shortList(silent)} (excluded)` : ''} (${secs(b.ms)} s)\n`,
    );
    for (const p of todo) {
      const why = [
        ...(p.tests.some((t) => failing.includes(t)) ? ['failing before the revert'] : []),
        ...(p.tests.some((t) => silent.includes(t)) ? ['the runner does not run them'] : []),
      ];
      p.tests = p.tests.filter((t) => !failing.includes(t) && !silent.includes(t));
      if (!p.tests.length)
        rows.push([p.f, 'NO-BASE', `the picked tests (${p.how}) are unusable: ${why.join(', ')}`]);
    }
  }
  const live = todo.filter((p) => p.tests.length);
  if (!live.length) return;

  // The forecast, before any revert: which files the budget is expected to hold, in rank order.
  if (model.est(1) !== null) {
    let room = left();
    let total = 0;
    const out = [];
    for (const p of live) {
      const e = model.est(p.tests.length);
      if (e <= room) {
        room -= e;
        total += e;
      } else out.push(p.f);
    }
    process.stdout.write(
      `· estimate: ≈${secs(total)} s for ${live.length - out.length} file(s) (a run with 1 test file ≈${secs(model.est(1))} s), ` +
        `package budget left ≈${secs(left())} s${out.length ? ` · will not fit by the estimate: ${out.join(', ')}` : ''}\n`,
    );
  }

  if (QUICK) {
    // One run with every file reverted: GREEN is already the verdict for the whole change.
    for (const p of live) save(p.f);
    for (const p of live) revert(p.f);
    let r;
    // Every file is put back before anything is thrown (a throw inside `finally` would also swallow
    // the run's own error); the outer restore() still settles whatever stayed reverted.
    const stuck = [];
    try {
      r = await execTree(
        RUNNER.build(listOf([...new Set(live.flatMap((p) => p.tests))]), true),
        Number(flag('timeout')) || Math.max(left(), 60_000),
        env,
      );
    } finally {
      for (const p of live) if (!putFileBack(p.f)) stuck.push(p.f);
    }
    if (stuck.length) throw new Error(`could not write ${stuck.join(', ')} back`);
    spent += r.ms;
    rows.push([
      `all ${live.length} files at once`,
      r.timedOut ? 'UNCHECKED' : redVs(r, known) ? 'RED' : 'GREEN',
      'picked tests only',
    ]);
    return;
  }

  const t0 = Date.now();
  for (const [i, p] of live.entries()) {
    // Decided BEFORE the run with the model refined by every run so far — a run is never started to be killed.
    // A resume reuses the baseline (memo above), so it spends the budget on reverts only and converges; a single
    // revert dearer than the WHOLE budget never would — the cut names the --budget that fits it.
    const e = model.est(p.tests.length);
    const tag = `[${i + 1}/${live.length}] ${p.f}`;
    if (e !== null && e > BUDGET_MS) {
      budgetCut(
        p,
        `one revert ≈${secs(e)} s costs more than the whole budget — a rerun will not converge, needs --budget ${Math.ceil(e / 60_000) + 1}`,
      );
      process.stdout.write(`${tag} → UNCHECKED (revert dearer than the budget)\n`);
      continue;
    }
    if (e === null ? left() < 30_000 : e > left()) {
      budgetCut(
        p,
        e === null
          ? 'under 30 s left'
          : `estimate ≈${secs(e)} s, left ≈${secs(Math.max(left(), 0))} s`,
      );
      process.stdout.write(`${tag} → UNCHECKED (budget)\n`);
      continue;
    }
    const s0 = Date.now();
    save(p.f);
    revert(p.f);
    let r;
    let back;
    try {
      // Bail stops at the FIRST failure — with a known-red baseline that may be a known one, hiding the new.
      r = await execTree(
        RUNNER.build(listOf(p.tests), !known),
        Number(flag('timeout')) || Math.max(left(), 2 * (e ?? 0), 60_000),
        env,
      );
    } finally {
      back = putFileBack(p.f);
    }
    if (!back) throw new Error(`could not write ${p.f} back`);
    spent += r.ms;
    if (!r.timedOut) model.add(p.tests.length, r.ms);
    const by = `${p.how}${p.capped ? ', the other graph tests were not run' : ''}`;
    if (r.timedOut) rows.push([p.f, 'UNCHECKED', `run cut by time (${by})`]);
    else if (redVs(r, known)) {
      const kind = SYMBOL_RED.test(r.out) ? 'RED·symbol' : 'RED';
      rows.push([
        p.f,
        kind,
        kind === 'RED'
          ? `the revert breaks its own tests (${by}) — covered`
          : `the import of a vanished symbol failed, not a behaviour check (${by})`,
      ]);
    } else
      rows.push([
        p.f,
        'GREEN',
        `the revert does not break the picked tests${r.status !== 0 ? ' beyond those failing before it' : ''} (${by}) — NOT covered by them`,
      ]);
    const done = i + 1;
    const eta = Math.round((((Date.now() - t0) / done) * (live.length - done)) / 1000);
    process.stdout.write(
      `${tag} → ${rows.at(-1)[1]} (${secs(Date.now() - s0)} s${live.length > done ? `, ≈${eta} s left` : ''})\n`,
    );
  }
}

try {
  if (!files.length) {
    /* every verdict came from the memo */
  } else if (SELECT) {
    await selectMode();
  } else if (GRAPH) {
    await graphMode();
  } else if (QUICK) {
    // One run with everything reverted: cheap, and a GREEN here is already a verdict — nothing in the
    // whole change is covered. A RED only says *something* is, which is why it is not the default.
    for (const f of files) save(f);
    const kinds = files.map((f) => [f, revert(f)]);
    const skipped = kinds.filter(([, k]) => k === 'new').map(([f]) => f);
    const r = run();
    restore();
    const verdict = redVs(r, KNOWN) ? 'RED' : 'GREEN';
    rows.push([
      `all ${files.length} files at once`,
      verdict,
      skipped.length ? `new files skipped: ${skipped.length}` : '',
    ]);
    if (verdict === 'GREEN') exitCode = 1;
  } else {
    const list = files; // already cut: the sample per package, --files by an explicit --max (overflow)
    // The cheap question first: with everything reverted, does the check notice at all? GREEN is the
    // verdict for the whole change and the per-file runs would only repeat it, one suite-length each.
    let nothingCovered = false;
    if (!TEMPLATED && list.length > 2) {
      for (const f of list) save(f);
      for (const f of list) revert(f);
      const all = run();
      for (const f of list) putFileBack(f);
      if (!redVs(all, KNOWN)) {
        nothingCovered = true;
        exitCode = 1;
        for (const f of list)
          rows.push([f, 'GREEN', 'the combined revert does not break the check — NONE is covered']);
      }
    }
    // One baseline for all narrowed runs, where the runner allows it (see MULTI_FILE).
    let unionGreen = false;
    if (TEMPLATED && list.length > 1 && MULTI_FILE.test(CMD)) {
      const union = run(null, cmdForMany(list));
      if (noTests(union)) stopNoTests(union.stdout);
      unionGreen = union.status === 0;
      process.stdout.write(
        `· one baseline over ${list.length} files: ${unionGreen ? 'green — no per-file baselines needed' : 'red — every file gets its own'} (${Math.round(spent / 1000)} s)\n`,
      );
    }
    const todo = nothingCovered ? [] : list;
    let narrowRuns = 0;
    const startedAt = Date.now();
    todo.forEach((path, i) => {
      const before = rows.length;
      const t0 = Date.now();
      // The budget holds here too (no file cap): an un-narrowed revert costs one whole check run.
      const per = i ? (Date.now() - startedAt) / i : TEMPLATED ? 0 : baselineMs;
      if (Date.now() - startedAt + baselineMs + per > BUDGET_MS) {
        rows.push([
          path,
          'UNCHECKED',
          `unchecked — budget ${BUDGET_MS / 60_000} min: estimate ≈${Math.round(per / 1000)} s per file; re-run — proven files are not repeated`,
        ]);
        process.stdout.write(`[${i + 1}/${todo.length}] ${path} → UNCHECKED (budget)\n`);
        return;
      }
      judge(path);
      // A line per file: a long run watched from outside (a background task, a lane) shows its pace
      // instead of sitting silent until the table.
      const done = i + 1;
      const left = Math.round((((Date.now() - startedAt) / done) * (todo.length - done)) / 1000);
      const row = rows[before];
      process.stdout.write(
        `[${done}/${todo.length}] ${path} → ${row ? row[1] : '?'} (${Math.round((Date.now() - t0) / 1000)} s${todo.length > done ? `, ≈${left} s left` : ''})\n`,
      );
    });
    function judge(path) {
      save(path);
      let known = KNOWN;
      if (TEMPLATED && !unionGreen) {
        const own = run(path);
        // The first narrowed run without a test = a wrong --cmd: stop before spending a run per file on it.
        if (noTests(own)) {
          if (!narrowRuns) stopNoTests(own.stdout);
          rows.push([path, 'NO-BASE', 'the narrowed check ran no test at all']);
          exitCode = 1;
          return;
        }
        narrowRuns += 1;
        if (own.status !== 0) {
          known = failedTests(outOf(own));
          if (!known) {
            rows.push([
              path,
              'NO-BASE',
              'the narrowed check is red before the revert and names no failing test',
            ]);
            exitCode = 1;
            return;
          }
          process.stdout.write(
            `· ${path}: its own baseline is red — ${knownLine(known)}; RED only on a new failure\n`,
          );
        }
      }
      const kind = revert(path);
      if (kind === 'new') {
        rows.push([
          path,
          'SKIP',
          'new file — reverting it breaks the build, not a coverage signal',
        ]);
        return;
      }
      const r = run(path);
      // Put this file back before the next one, so each verdict is about one file alone. A file the
      // change DELETED has no local content: base content was written above, so removing it restores.
      putFileBack(path);
      if (redVs(r, known)) {
        const out = (r.stdout || '') + (r.stderr || '');
        if (unionGreen && NO_TESTS.test(out)) {
          rows.push([path, 'NO-BASE', 'no related tests — a red run without a single test']);
          exitCode = 1;
        } else if (SYMBOL_RED.test(out))
          rows.push([
            path,
            'RED·symbol',
            'the import of a vanished symbol failed, not a behaviour check',
          ]);
        else rows.push([path, 'RED', 'the revert breaks the check — covered']);
      } else {
        rows.push([
          path,
          'GREEN',
          r.status !== 0
            ? 'the revert fails no test beyond those failing before it — NOT covered'
            : 'the revert does not break the check — NOT covered',
        ]);
        exitCode = 1;
      }
    }
    restored = false;
    restore();
  }
} finally {
  if (!restore()) process.exit(2);
}

if (overflow.length)
  rows.push([
    `… ${overflow.length} more file(s)`,
    'SKIP',
    `--max ${MAX} exceeded: ${overflow.join(', ')}`,
  ]);
for (const [f, v, note] of rows) if (!note.includes('same tree')) remember(f, v, note);
if (rows.some(([, v]) => v === 'GREEN' || v === 'NO-BASE')) exitCode = 1;

// ---- report ---------------------------------------------------------------------------------------
const w = Math.max(...rows.map(([f]) => f.length), 6);
process.stdout.write(`\n| ${'File'.padEnd(w)} | Revert to base | What it means  |\n`);
process.stdout.write(`|${'-'.repeat(w + 2)}|----------------|----------------|\n`);
for (const [f, v, note] of rows) {
  process.stdout.write(`| ${f.padEnd(w)} | ${v.padEnd(14)} | ${note} |\n`);
}
const green = rows.filter(([, v]) => v === 'GREEN').length;
const symbolRed = rows.filter(([, v]) => v === 'RED·symbol').length;
const noBase = rows.filter(([, v]) => v === 'NO-BASE').length;
process.stdout.write(
  `\nMUSTFAIL: ${rows.filter(([, v]) => v.startsWith('RED')).length} red${symbolRed ? ` (${symbolRed} of them by symbol)` : ''} · ${green} green · ` +
    `${noBase ? `${noBase} without a base check · ` : ''}${rows.some(([, v]) => v === 'UNCHECKED') ? `${rows.filter(([, v]) => v === 'UNCHECKED').length} UNCHECKED (budget) · ` : ''}${rows.filter(([, v]) => v === 'SKIP').length} skipped · ${Math.round(spent / 1000)} s\n`,
);
if (!SELECT && !TEMPLATED && baselineMs > 30_000)
  process.stdout.write(
    `One check run takes ${Math.round(baselineMs / 1000)} s and repeats per file. Narrow it with the {file} placeholder:\n` +
      '  --cmd "npm run test:ci" for vitest/jest (tests are picked by @covers) · "pytest {tests}" · "go test ./<file package>/..."\n',
  );
if (symbolRed) {
  process.stdout.write(
    'RED·symbol = the revert removed an export or module and the check failed at import. What the symbol DOES was never checked:\n' +
      'the expectation must come from an independent source (a known number, an example from the spec), not the same formula.\n',
  );
}
if (green) {
  process.stdout.write(
    'A green revert = the check cannot go red on this file. Either a test of its behaviour is missing,\n' +
      'or it checks the wrong thing. It cannot be cited as proof.\n',
  );
}
// No RED row = no file was judged (all new / skipped): exit 0 here read as «every file covered» while
// nothing was proven — the other half of finding 94a's false green.
if (exitCode === 0 && !rows.some(([, v]) => v.startsWith('RED'))) {
  console.error(
    rows.some(([, v]) => v === 'UNCHECKED')
      ? 'mustfail: nothing proven — the time budget cut every judged file. Re-run (proven files come from the memo) or raise --budget.'
      : 'mustfail: nothing proven — no target could be reverted (new files). Prove new code with --mutants.',
  );
  process.exit(2);
}
// A file someone edited mid-run was left as is: the verdicts above ran on a tree nobody owned alone.
if (keepBackups) {
  console.error(
    'mustfail: a file changed under the run (see CHANGED above) — verdicts are not trustworthy, re-run on a quiet tree.',
  );
  process.exit(2);
}
process.exit(exitCode);
