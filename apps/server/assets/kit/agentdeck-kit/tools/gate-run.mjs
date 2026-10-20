#!/usr/bin/env node
/**
 * gate-run — run the project's OWN verdict commands as one gate (skill `agentdeck-kit:ticket-delivery-2` §6).
 *
 * Why. Four commands in a row are four chances to forget one and then honestly believe everything
 * was green. One command runs the whole discovered list, keeps one line per green gate, shows only
 * the tail of a red one, and prints a single verdict.
 *
 * Why it writes the ledger. The `06-gates` line is written by whoever SAW the exit codes. A line
 * typed by hand afterwards is a claim about codes nobody watched, and it is indistinguishable from
 * evidence once it is in the file.
 *
 * The commands are NOT invented here and nothing is reimplemented: they are discovered per project
 * (package scripts, Makefile, the CI config, a project doc that names the gate) and passed in, so
 * what runs is exactly what CI runs.
 *
 *   node <kit>/tools/gate-run.mjs --ticket PROJ-777 "lint=npm run lint" "test=npm run test:ci"
 *   node <kit>/tools/gate-run.mjs "go build ./..." "go test ./..."     # label = the command
 *   node <kit>/tools/gate-run.mjs --dry ...          # show the plan only
 *   node <kit>/tools/gate-run.mjs --no-ledger ...    # do not write the ledger row
 *   node <kit>/tools/gate-run.mjs --fresh ...        # rerun gates already green on this tree
 *   node <kit>/tools/gate-run.mjs --cwd services/api --stage 06-gates ...
 *   node <kit>/tools/gate-run.mjs --affected [--base main] "type=pnpm type-check" "always:brand=pnpm brand"
 *
 * `--affected`: the positionals are the FULL gate; `affected.mjs` decides whether the change lets the
 * run stay inside the touched zones (their own commands replace the positionals — CI still runs
 * everything) or must run full, and says why. `always:` gates run in both modes. A green full run
 * records its duration, a green scoped run each zone's — the next verdict weighs real numbers.
 *
 * Exit: 0 all green · 1 at least one red · 2 bad invocation.
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const LEDGER = join(dirname(fileURLToPath(import.meta.url)), 'ticket-ledger.mjs');
/** Beside this file: the kit copy runs its own sibling, not the home one. */
const AFFECTED = join(dirname(fileURLToPath(import.meta.url)), 'affected.mjs');
/** How many trailing lines of a red gate are worth paying for: fixes come from the end. */
const TAIL = 40;

function projectRoot() {
  const r = spawnSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' });
  const top = r.status === 0 ? String(r.stdout || '').trim() : '';
  return top || process.cwd();
}

const ROOT = projectRoot();
const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};
const has = (name) => args.includes(name);

const DRY = has('--dry');
const NO_LEDGER = has('--no-ledger');
const FRESH = has('--fresh');
const STAGE = flag('--stage', '06-gates');
const CWD = flag('--cwd', '');
const AFFECTED_MODE = has('--affected');

/** Positionals are the gates; everything consumed by a flag is dropped. */
const VALUED = new Set(['--ticket', '--stage', '--cwd', '--base']);
const positional = [];
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (VALUED.has(a)) {
    i += 1;
    continue;
  }
  if (a.startsWith('--')) continue;
  positional.push(a);
}

if (positional.length === 0) {
  process.stderr.write(
    "gate-run: no gate given. Pass the project's own verdict commands, e.g.\n" +
      '  node <kit>/tools/gate-run.mjs --ticket PROJ-777 "lint=npm run lint" "test=npm run test:ci"\n' +
      'Discover them from package scripts, the Makefile or the CI config — never invent a gate.\n',
  );
  process.exit(2);
}

const DEFAULT_CWD = CWD ? join(ROOT, CWD) : ROOT;

/** `label=command`, or a bare command that labels itself; `always:` marks a gate scoping never drops. */
const declared = positional.map((raw) => {
  const always = raw.startsWith('always:');
  const body = always ? raw.slice('always:'.length) : raw;
  const m = body.match(/^([\w.:-]{1,24})=(.+)$/s);
  const gate = m
    ? { label: m[1], cmd: m[2] }
    : { label: body.length > 28 ? `${body.slice(0, 27)}…` : body, cmd: body };
  return { ...gate, always, cwd: DEFAULT_CWD };
});

let gates = declared;
let scope = null;
if (AFFECTED_MODE) {
  const { computeAffected, formatAffected } = await import(pathToFileURL(AFFECTED).href);
  scope = computeAffected({ cwd: ROOT, base: flag('--base', undefined) });
  process.stdout.write(`${formatAffected(scope)}\n`);
  if (scope.verdict !== 'full') {
    const zoneGates = (scope.zones ?? []).flatMap((z) =>
      z.commands.map((c) => ({
        label: `${z.dir === '.' ? 'root' : z.dir.split('/').pop()}:${c.label}`,
        cmd: c.cmd,
        cwd: join(ROOT, z.dir),
        zone: z.dir,
      })),
    );
    gates = [...declared.filter((g) => g.always), ...zoneGates];
  }
}

/**
 * Every tracker key in the branch name, comma-separated: with `fix-A-1,A-2/<slug>` the gate row is
 * owed to EACH ledger, because a stop guard demands them all.
 * `branch --show-current` and not `rev-parse --abbrev-ref`: the first answers with a name even on a
 * branch with no commits.
 */
function keysFromBranch() {
  const r = spawnSync('git', ['branch', '--show-current'], { cwd: ROOT, encoding: 'utf8' });
  const branch = r.status === 0 ? String(r.stdout || '').trim() : '';
  const ids = [...branch.matchAll(/\b[A-Z][A-Z0-9]{0,9}-\d+\b/g)].map((m) => m[0].toUpperCase());
  return [...new Set(ids)].join(',');
}

// ---- green memo: a gate already green on this exact tree is not run again ------------------------
// Key = (tree, cwd, command). The tree is the working copy as `git add -A` would write it (a temp index,
// the real one untouched): a commit does not change it, any edited byte does. Only green is remembered,
// and only when the run left the tree as it found it (an autofix that rewrote files proved the old tree).
// `--fresh` ignores the memo.
function gitIn(argv, env) {
  return spawnSync('git', argv, { cwd: ROOT, encoding: 'utf8', env });
}

const STATE = (() => {
  const r = gitIn(['rev-parse', '--git-path', 'gate-run']);
  return r.status === 0 ? resolve(ROOT, String(r.stdout).trim()) : null;
})();

function treeKey() {
  if (!STATE || FRESH) return null;
  const idx = join(STATE, `idx-${process.pid}`);
  try {
    mkdirSync(STATE, { recursive: true });
    const real = resolve(ROOT, String(gitIn(['rev-parse', '--git-path', 'index']).stdout).trim());
    if (existsSync(real)) copyFileSync(real, idx);
    const env = { ...process.env, GIT_INDEX_FILE: idx };
    if (gitIn(['-c', 'core.autocrlf=false', 'add', '-A', '--', ':/'], env).status !== 0)
      return null;
    return String(gitIn(['write-tree'], env).stdout).trim() || null;
  } catch {
    return null;
  } finally {
    rmSync(idx, { force: true });
  }
}

const memoFile = (tree, gate) =>
  join(
    STATE,
    'memo',
    `${createHash('sha256')
      .update(
        JSON.stringify([
          tree,
          resolve(gate.cwd) === resolve(ROOT) ? '' : resolve(gate.cwd),
          gate.cmd,
        ]),
      )
      .digest('hex')
      .slice(0, 32)}.json`,
  );

function recall(tree, gate) {
  if (!tree) return null;
  try {
    return JSON.parse(readFileSync(memoFile(tree, gate), 'utf8'));
  } catch {
    return null;
  }
}

function remember(tree, gate) {
  if (!tree) return;
  try {
    mkdirSync(join(STATE, 'memo'), { recursive: true });
    writeFileSync(
      memoFile(tree, gate),
      JSON.stringify({ at: new Date().toISOString().slice(0, 16).replace('T', ' ') }),
    );
  } catch {
    /* a memo that cannot be written only costs the next run time */
  }
}

function run(gate) {
  const started = Date.now();
  const r = spawnSync(gate.cmd, {
    cwd: gate.cwd,
    encoding: 'utf8',
    shell: true,
    maxBuffer: 64 * 1024 * 1024,
  });
  const seconds = ((Date.now() - started) / 1000).toFixed(1);
  const out = String(r.stdout || '') + String(r.stderr || '');
  // status === null means the process never started (no binary on PATH) — that is not "green".
  const code = r.status === null ? 127 : r.status;
  return { code, seconds, out };
}

process.stdout.write(`gate-run: ${gates.length} gate(s) in ${DEFAULT_CWD}\n`);

if (DRY) {
  for (const g of gates)
    process.stdout.write(
      `  plan: ${g.label} → ${g.cmd}${resolve(g.cwd) === resolve(DEFAULT_CWD) ? '' : ` (in ${g.cwd})`}\n`,
    );
  process.exit(0);
}

const results = [];
let red = 0;
let tree = treeKey();
for (const gate of gates) {
  const memo = recall(tree, gate);
  if (memo) {
    results.push({ label: gate.label, code: 0, seconds: '0.0', out: '', cached: true });
    process.stdout.write(
      `  ok   ${gate.label} (cached: green on this same tree at ${memo.at}; --fresh reruns)\n`,
    );
    continue;
  }
  process.stdout.write(`  … ${gate.label}\n`);
  const r = run(gate);
  if (tree) {
    const after = treeKey();
    if (r.code === 0 && after === tree) remember(tree, gate);
    tree = after;
  }
  results.push({ label: gate.label, zone: gate.zone, ...r });
  if (r.code !== 0) red++;
  process.stdout.write(
    `  ${r.code === 0 ? 'ok  ' : 'RED '} ${gate.label} (${r.seconds}s, exit ${r.code})\n`,
  );
  if (r.code !== 0) {
    const tail = r.out.split('\n').filter(Boolean).slice(-TAIL).join('\n');
    process.stdout.write(`${tail}\n`);
  }
}

const scopeTag = scope
  ? `affected ${scope.verdict}${scope.verdict === 'scoped' ? ` ${scope.affected.length}/${scope.total}` : ''}: `
  : '';
const summary =
  scopeTag +
  (results.map((r) => `${r.label} ${r.code}${r.cached ? ' (cached)' : ''}`).join(' · ') ||
    'nothing to check');
process.stdout.write(`\nVERDICT: ${red === 0 ? 'green' : `red (${red})`} — ${summary}\n`);

// Timings feed affected.mjs: only fresh green runs measure anything (a cached gate took 0 s).
if (scope && red === 0 && results.length && results.every((r) => !r.cached)) {
  const { writeTiming } = await import(pathToFileURL(AFFECTED).href);
  if (scope.verdict === 'full') {
    writeTiming(ROOT, { full: results.reduce((s, r) => s + Number(r.seconds), 0) });
  } else {
    const zones = {};
    for (const r of results.filter((r) => r.zone))
      zones[r.zone] = (zones[r.zone] ?? 0) + Number(r.seconds);
    writeTiming(ROOT, { zones });
  }
}

const ticket = flag('--ticket', keysFromBranch());
if (!NO_LEDGER && ticket) {
  spawnSync(process.execPath, [LEDGER, 'add', ticket, STAGE, red === 0 ? 'ok' : 'red', summary], {
    cwd: ROOT,
    // The row is written as the gates finish: exempt from the ledger's same-minute batch refusal.
    env: { ...process.env, TICKET_LEDGER_WITNESS: 'gate-run' },
    stdio: 'inherit',
  });
} else if (!NO_LEDGER) {
  process.stdout.write(
    'gate-run: no ticket key in the branch name — no ledger row written. Pass --ticket <KEY>.\n',
  );
}

process.exit(red === 0 ? 0 : 1);
