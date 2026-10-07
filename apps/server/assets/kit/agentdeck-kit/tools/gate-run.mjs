#!/usr/bin/env node
/**
 * gate-run — run the project's OWN verdict commands as one gate (skill `agentdeck-kit:ticket-delivery` §6).
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
 *   node <kit>/tools/gate-run.mjs --cwd services/api --stage 06-gates ...
 *
 * Exit: 0 all green · 1 at least one red · 2 bad invocation.
 */
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const LEDGER = join(dirname(fileURLToPath(import.meta.url)), 'ticket-ledger.mjs');
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
const STAGE = flag('--stage', '06-gates');
const CWD = flag('--cwd', '');

/** Positionals are the gates; everything consumed by a flag is dropped. */
const VALUED = new Set(['--ticket', '--stage', '--cwd']);
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

/** `label=command`, or a bare command that labels itself. */
const gates = positional.map((raw) => {
  const m = raw.match(/^([\w.:-]{1,24})=(.+)$/s);
  return m
    ? { label: m[1], cmd: m[2] }
    : { label: raw.length > 28 ? `${raw.slice(0, 27)}…` : raw, cmd: raw };
});

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

function run(gate) {
  const started = Date.now();
  const r = spawnSync(gate.cmd, {
    cwd: CWD ? join(ROOT, CWD) : ROOT,
    encoding: 'utf8',
    shell: true,
  });
  const seconds = ((Date.now() - started) / 1000).toFixed(1);
  const out = String(r.stdout || '') + String(r.stderr || '');
  // status === null means the process never started (no binary on PATH) — that is not "green".
  const code = r.status === null ? 127 : r.status;
  return { code, seconds, out };
}

process.stdout.write(`gate-run: ${gates.length} gate(s) in ${CWD ? join(ROOT, CWD) : ROOT}\n`);

if (DRY) {
  for (const g of gates) process.stdout.write(`  plan: ${g.label} → ${g.cmd}\n`);
  process.exit(0);
}

const results = [];
let red = 0;
for (const gate of gates) {
  process.stdout.write(`  … ${gate.label}\n`);
  const r = run(gate);
  results.push({ label: gate.label, ...r });
  if (r.code !== 0) red++;
  process.stdout.write(
    `  ${r.code === 0 ? 'ok  ' : 'RED '} ${gate.label} (${r.seconds}s, exit ${r.code})\n`,
  );
  if (r.code !== 0) {
    const tail = r.out.split('\n').filter(Boolean).slice(-TAIL).join('\n');
    process.stdout.write(`${tail}\n`);
  }
}

const summary = results.map((r) => `${r.label} ${r.code}`).join(' · ');
process.stdout.write(`\nVERDICT: ${red === 0 ? 'green' : `red (${red})`} — ${summary}\n`);

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
