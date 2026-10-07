#!/usr/bin/env node
// mustfail — proves a check can go RED before its green run is believed.
//
// The invariant ("a check that cannot go red is decoration") has lived in CLAUDE.md as a habit since
// 17.09.2026. A habit is skippable; this is not. The mutation is the cheapest one that is always
// available and always meaningful: put a changed file back to its base revision and re-run the check.
// A file whose revert leaves the suite green is a file the suite does not actually cover, whatever
// `@covers` claims and whatever the coverage percentage says.
//
//   node <kit>/tools/mustfail.mjs --cmd "npm run test:ci" [--base origin/main] [--files a,b]
//   node <kit>/tools/mustfail.mjs --cmd "..." --quick     # one run, all files reverted at once
//   node <kit>/tools/mustfail.mjs --cmd "npx vitest related {file} --run"   # narrowed per file
//   node <kit>/tools/mustfail.mjs --cmd "..." --mutants plan.json            # new tests, old code
//   node <kit>/tools/mustfail.mjs --cmd "..." --mutate src/x.ts --find "a >= b" --replace "a > b" [--test "name"]
//
// {file} (relative to --cwd) and {abs} in --cmd make every run about ONE file: its own baseline, its
// own revert. Measured 18.09.2026: four files against a one-minute suite took 5m21s, because every
// revert re-ran everything. Narrowed by the import graph the same verdicts cost seconds — and a tool
// that takes five minutes is a tool that gets skipped, which is the only way this check ever fails.
// Un-narrowed and more than two files: one combined revert runs first, because GREEN there already is
// the verdict for the whole change and saves every per-file run after it.
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
} from 'node:fs';
import { join, dirname, posix, resolve, basename, isAbsolute, relative } from 'node:path';
import { tmpdir } from 'node:os';

const argv = process.argv.slice(2);
const flag = (name, fallback = null) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : fallback;
};
const has = (name) => argv.includes(`--${name}`);

const CMD = flag('cmd');
const BASE = flag('base');
const CWD = flag('cwd', process.cwd());
const MAX = Number(flag('max', '6'));
const QUICK = has('quick');

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
/** Every file is back: the journal and the backups have nothing left to protect. */
function closeJournal() {
  try {
    rmSync(JOURNAL, { force: true });
    rmSync(BACKUPS, { recursive: true, force: true });
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

/** Settle journals of dead runs in this tree; refuse while another live run owns it. */
function settle() {
  let names;
  try {
    names = readdirSync(STATE).filter((n) => /^journal-\d+\.json$/.test(n));
  } catch {
    return;
  }
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
    if (j.pid === process.pid || j.scope !== SCOPE) continue;
    if (alive(j.pid))
      refuse(
        `another mustfail run (pid ${j.pid}, started ${j.started}) is rewriting this tree right now — a second run would ` +
          `back up its mutations as originals. Wait for it; if pid ${j.pid} is not mustfail, delete ${file}.`,
      );
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
}

settle();
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

// Which shell runs the check is not a detail: on Windows `shell: true` is cmd.exe, and a POSIX-shaped
// command handed to it can SUCCEED where it was meant to fail. Measured 18.09.2026 while testing this
// very tool — `node -e 'process.exit(1)'` exited 0 under cmd.exe, because the single quotes became part
// of the script and nothing ever called exit. A false green inside the thing that exists to catch false
// greens is the worst possible bug here, so the user's own shell wins when there is one.
const SHELL = process.env.SHELL && existsSync(process.env.SHELL) ? process.env.SHELL : true;
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
if (flag('mutants') || argv.includes('--mutate')) process.exit(await runMutants());

async function runMutants() {
  // --replace "" is a legitimate mutant (delete a call), so these read the raw next argument.
  const raw = (name) => {
    const i = argv.indexOf(`--${name}`);
    return i >= 0 && i + 1 < argv.length ? argv[i + 1] : null;
  };
  let plan;
  if (flag('mutants')) {
    try {
      plan = JSON.parse(readFileSync(resolve(CWD, flag('mutants')), 'utf8'));
    } catch (e) {
      console.error(`mustfail: cannot read the mutant plan — ${e.message}`);
      return 2;
    }
    if (!Array.isArray(plan)) plan = [plan];
    // An empty plan (review-sweep over lines with nothing to mutate) proves nothing: exit 2 like K7, not a crash.
    if (!plan.length) {
      console.error('mustfail: nothing proven — the mutant plan is empty.');
      return 2;
    }
  } else {
    plan = [{ file: raw('mutate'), find: raw('find'), replace: raw('replace'), test: raw('test') }];
  }

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
    if (problems.length) return null;
    const k = at[(nth ?? 1) - 1];
    const mutated = Buffer.from(text.slice(0, k) + replace + text.slice(k + find.length), 'utf8');
    const identity = Buffer.from(text.slice(0, k) + find + text.slice(k + find.length), 'utf8');
    return { ...m, full, before, mutated, identity, line: lineOf(k) };
  });
  if (problems.length) {
    console.error(`mustfail: the mutant plan cannot run:\n  ${problems.join('\n  ')}`);
    return 2;
  }

  const templated = /\{file\}|\{abs\}/.test(CMD);
  const cmdFor = (m) =>
    templated
      ? CMD.replaceAll('{file}', m.file.replaceAll('\\', '/')).replaceAll('{abs}', m.full)
      : CMD;
  let spentMs = 0;
  // Async, because a timeout must kill the whole tree: spawnSync's timeout kills only the shell, and the
  // test runner under it kept spinning (fixture run 23.09.2026) — a mutant loop would burn a core for good.
  const killTree = (pid) => {
    if (process.platform === 'win32')
      spawnSync('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true });
    else
      try {
        process.kill(-pid, 'SIGKILL');
      } catch {
        /* already gone */
      }
  };
  const exec = (cmd, timeout) =>
    new Promise((done) => {
      const t0 = Date.now();
      const child = spawn(cmd, {
        cwd: CWD,
        shell: SHELL,
        windowsHide: true,
        detached: process.platform !== 'win32',
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
        spentMs += Date.now() - t0;
        done({ status: status ?? 1, timedOut, out });
      });
    });

  process.stdout.write(`mustfail · mutants · ${muts.length} · ${CMD}\n`);
  // Baseline per distinct command: every mutant is judged against a run that was green untouched.
  const slowest = new Map();
  for (const cmd of new Set(muts.map(cmdFor))) {
    const t0 = Date.now();
    const r = await exec(cmd);
    slowest.set(cmd, Date.now() - t0);
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
  const putBack = () => {
    if (!live) return true;
    const { full, before } = live;
    try {
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
    track(m.full, m.before);
    intend(m.full, bytes);
    live = m;
    writeFileSync(m.full, bytes);
  };

  // Failing-test lines as runners print them: vitest/jest (FAIL, ×, ✕, ●), node:test (✖, not ok),
  // go (--- FAIL), pytest (FAILED), playwright (✘). Used to name WHICH test killed a mutant — the
  // 23.09.2026 lesson: the first failure in the file is not necessarily the targeted one.
  const FAIL_LINE = /\bFAIL(?:ED)?\b|[×✕✖✘●]|\bnot ok\b/;
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
    apply(c, c.identity);
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
      apply(m, m.mutated);
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
        [verdict, note] = ['GREEN', 'mutant survived — no test catches this behaviour'];
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
// the long path while the caller may hold the 8.3 short one (C:\Users\RUSYAN~1), and `relative()`
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
    return out;
  }
  const seen = new Set();
  for (const args of [
    ['diff', '--name-only', `${base}...HEAD`],
    ['diff', '--name-only'],
    ['diff', '--name-only', '--cached'],
  ]) {
    for (const line of (git(args).stdout || '').split('\n')) {
      const f = line.trim();
      if (f && SOURCE.test(f) && !NOT_BEHAVIOUR.test(f)) seen.add(f);
    }
  }
  return [...seen];
}

const files = targets();
if (!files.length) {
  console.error(
    `mustfail: no behaviour-bearing changed source files against ${base} — nothing to prove`,
  );
  process.exit(2);
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
let spent = 0;

const run = (path = null) => {
  const started = Date.now();
  const r = spawnSync(path && TEMPLATED ? cmdFor(path) : CMD, {
    cwd: CWD,
    shell: SHELL,
    encoding: 'utf8',
    maxBuffer: 64 << 20,
  });
  spent += Date.now() - started;
  return r;
};
if (TEMPLATED && QUICK) {
  console.error(
    'mustfail: --quick reverts every file at once — it cannot be combined with a per-file {file} command',
  );
  process.exit(2);
}

// ---- baseline: the check must be green before a mutation means anything -------------------------
process.stdout.write(`mustfail · base ${base} · ${files.length} file(s) · ${CMD}\n`);
// A templated command has no single baseline: each file is measured against its own narrowed run.
const baseline = TEMPLATED ? { status: 0 } : run();
const baselineMs = spent;
if (baseline.status !== 0) {
  const tail = (baseline.stdout || '').split('\n').slice(-12).join('\n');
  console.error(
    `\nmustfail: the check is ALREADY RED before any mutation — fix it first, a red check proves nothing.\n${tail}`,
  );
  process.exit(2);
}

// ---- mutation ------------------------------------------------------------------------------------
/** @type {Map<string, {full: string, before: Buffer|null, backup: string}>} */
const saved = new Map();
let restored = false;

function save(path) {
  const full = join(root, path);
  const before = existsSync(full) ? readFileSync(full) : null;
  const backup = track(full, before);
  saved.set(path, { full, before, backup });
}

function restore() {
  if (restored) return true;
  restored = true;
  const broken = [];
  for (const [path, { full, before }] of saved) {
    try {
      if (before === null) {
        if (existsSync(full)) unlinkSync(full);
      } else {
        writeFileSync(full, before);
        if (!readFileSync(full).equals(before)) broken.push(path);
      }
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
  const { full } = saved.get(path);
  const content = atBase(path);
  if (content === null) return 'new';
  intend(full, content);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, content);
  return 'reverted';
}

const rows = [];
let exitCode = 0;

try {
  if (QUICK) {
    // One run with everything reverted: cheap, and a GREEN here is already a verdict — nothing in the
    // whole change is covered. A RED only says *something* is, which is why it is not the default.
    for (const f of files) save(f);
    const kinds = files.map((f) => [f, revert(f)]);
    const skipped = kinds.filter(([, k]) => k === 'new').map(([f]) => f);
    const r = run();
    restore();
    const verdict = r.status !== 0 ? 'RED' : 'GREEN';
    rows.push([
      `all ${files.length} files at once`,
      verdict,
      skipped.length ? `new files skipped: ${skipped.length}` : '',
    ]);
    if (verdict === 'GREEN') exitCode = 1;
  } else {
    const list = files.slice(0, MAX);
    // The cheap question first: with everything reverted, does the check notice at all? GREEN is the
    // verdict for the whole change and the per-file runs would only repeat it, one suite-length each.
    let nothingCovered = false;
    if (!TEMPLATED && list.length > 2) {
      for (const f of list) save(f);
      for (const f of list) revert(f);
      const all = run();
      for (const f of list) {
        const { full, before } = saved.get(f);
        if (before === null) {
          if (existsSync(full)) unlinkSync(full);
        } else writeFileSync(full, before);
      }
      if (all.status === 0) {
        nothingCovered = true;
        exitCode = 1;
        for (const f of list)
          rows.push([f, 'GREEN', 'the combined revert does not break the check — NONE is covered']);
      }
    }
    for (const path of nothingCovered ? [] : list) {
      save(path);
      if (TEMPLATED) {
        const own = run(path);
        if (own.status !== 0) {
          rows.push([
            path,
            'NO-BASE',
            'the narrowed check is red before the revert: no related tests, or they already fail',
          ]);
          exitCode = 1;
          continue;
        }
      }
      const kind = revert(path);
      if (kind === 'new') {
        rows.push([
          path,
          'SKIP',
          'new file — reverting it breaks the build, not a coverage signal',
        ]);
        continue;
      }
      const r = run(path);
      // Put this file back before the next one, so each verdict is about one file alone. A file the
      // change DELETED has no local content: base content was written above, so removing it restores.
      const { full, before } = saved.get(path);
      if (before === null) unlinkSync(full);
      else writeFileSync(full, before);
      if (r.status !== 0) {
        const out = (r.stdout || '') + (r.stderr || '');
        if (SYMBOL_RED.test(out))
          rows.push([
            path,
            'RED·symbol',
            'the import of a vanished symbol failed, not a behaviour check',
          ]);
        else rows.push([path, 'RED', 'the revert breaks the check — covered']);
      } else {
        rows.push([path, 'GREEN', 'the revert does not break the check — NOT covered']);
        exitCode = 1;
      }
    }
    if (files.length > list.length) {
      rows.push([`… ${files.length - list.length} more file(s)`, 'SKIP', `--max ${MAX} exceeded`]);
    }
    restored = false;
    restore();
  }
} finally {
  if (!restore()) process.exit(2);
}

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
    `${noBase ? `${noBase} without a base check · ` : ''}${rows.filter(([, v]) => v === 'SKIP').length} skipped · ${Math.round(spent / 1000)} s\n`,
);
if (!TEMPLATED && baselineMs > 30_000)
  process.stdout.write(
    `One check run takes ${Math.round(baselineMs / 1000)} s and repeats per file. Narrow it with the {file} placeholder:\n` +
      '  --cmd "npx vitest related {file} --run" · "go test ./<file package>/..." · "pytest <test of this module>"\n',
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
    'mustfail: nothing proven — no target could be reverted (new files). Prove new code with --mutants.',
  );
  process.exit(2);
}
process.exit(exitCode);
