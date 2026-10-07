#!/usr/bin/env node
/**
 * ticket-preflight — can a delivery run start RIGHT NOW. Read-only, creates nothing.
 *
 * Why. The conveyor (skill `agentdeck-kit:ticket-delivery`) claims the ticket first, at stage 1, and only
 * discovers the conditions it cannot work without later: a dirty tree at stage 2, the wrong runtime
 * major at the first gate, a missing server at the first write. An autonomous run then stops with a
 * ticket already assigned and moved to in-progress. This checks the same things BEFORE any write.
 *
 *   node <kit>/tools/ticket-preflight.mjs PROJ-777
 *   node <kit>/tools/ticket-preflight.mjs PROJ-1,PROJ-2 --need gitlab,jira
 *   node <kit>/tools/ticket-preflight.mjs login-empty-state        # ticket-less run, slug key
 *
 * Checked:
 *   · the Node major matches `.nvmrc`, when the project pins one — otherwise gates refuse to run;
 *   · the working tree is clean — the conveyor never stashes someone else's edits and never
 *     branches on top of them;
 *   · the working copy is not held by another run: a branch carrying a different key with an open
 *     ledger means another session lives here (a run halted with a question does not hold it);
 *   · MCP servers declared in `.mcp.json`. `--need` turns a missing one into a STOP; without it the
 *     list is informational. Whether a server actually attached to the session is invisible here —
 *     the agent checks that itself;
 *   · the key already has a ledger — this is a resume, and the first unclosed stage is named.
 *
 * Exit: 0 clear · 1 a STOP line, claim nothing and report · 2 bad invocation.
 * Output is English: the model reads it.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const LEDGER = join(dirname(fileURLToPath(import.meta.url)), 'ticket-ledger.mjs');
const TRACKER_RE = /^[A-Z][A-Z0-9]{0,9}-\d+$/;
const SLUG_RE = /^[a-z][a-z0-9-]{2,49}$/;

function projectRoot() {
  const r = spawnSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' });
  const top = r.status === 0 ? String(r.stdout || '').trim() : '';
  return top || process.cwd();
}

const ROOT = projectRoot();
const argv = process.argv.slice(2);
const flagValue = (name) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : '';
};
const NEED = flagValue('--need')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

const raw = argv.find((a) => !a.startsWith('--') && a !== flagValue('--need')) ?? '';
const keys = [
  ...new Set(
    raw
      .split(',')
      .map((t) => t.trim())
      .filter(Boolean),
  ),
].map((k) => (TRACKER_RE.test(k.toUpperCase()) ? k.toUpperCase() : k));
if (keys.length === 0 || !keys.every((k) => TRACKER_RE.test(k) || SLUG_RE.test(k))) {
  process.stderr.write(
    `ticket-preflight: expected PROJ-777, a slug, or a comma-separated list, got «${raw}».\n`,
  );
  process.exit(2);
}

const git = (...a) => {
  const r = spawnSync('git', a, { cwd: ROOT, encoding: 'utf8' });
  return r.status === 0 ? String(r.stdout || '') : '';
};

/** Ledger state: null — no ledger; else `{open, left, next, halted}` from `ticket-ledger check`. */
function ledgerState(key) {
  if (!existsSync(join(ROOT, '.agent', 'tickets', `${key}.agent.md`))) return null;
  const r = spawnSync(process.execPath, [LEDGER, 'check', key], { cwd: ROOT, encoding: 'utf8' });
  const out = String(r.stdout || '');
  const left = Number(out.match(/(\d+) stage\(s\) not closed/)?.[1] ?? 0);
  const next = out.match(/^\s+(\d\d-[a-z]+) — /m)?.[1] ?? '';
  return { open: r.status !== 0, left, next, halted: /halted on purpose/.test(out) };
}

let stops = 0;
const lines = [];
const say = (level, text) => {
  if (level === 'STOP') stops += 1;
  lines.push(`  ${level.padEnd(5)} ${text}`);
};

// ── runtime ──────────────────────────────────────────────────────────────────────────────────────
const nvmrc = existsSync(join(ROOT, '.nvmrc'))
  ? readFileSync(join(ROOT, '.nvmrc'), 'utf8').trim().replace(/^v/, '')
  : '';
const wantMajor = nvmrc.split('.')[0];
const haveMajor = process.versions.node.split('.')[0];
if (!wantMajor) say('note', 'node: no .nvmrc — major not checked');
else if (wantMajor === haveMajor) say('ok', `node ${process.versions.node} (.nvmrc ${nvmrc})`);
else
  say(
    'STOP',
    `node ${process.versions.node}, .nvmrc wants major ${wantMajor} — gates will refuse to run; switch first`,
  );

// ── working tree ─────────────────────────────────────────────────────────────────────────────────
const dirty = git('status', '--porcelain').split('\n').filter(Boolean);
if (dirty.length === 0) say('ok', 'working tree clean');
else
  say(
    'STOP',
    `working tree dirty (${dirty.length}): ${dirty
      .slice(0, 5)
      .map((l) => l.slice(3))
      .join(', ')}${dirty.length > 5 ? ', …' : ''} — never stashed silently`,
  );

// ── is the copy held by another run ──────────────────────────────────────────────────────────────
const branch = git('branch', '--show-current').trim();
const onBranch = [
  ...new Set([...branch.matchAll(/\b[A-Z][A-Z0-9]{0,9}-\d+\b/g)].map((m) => m[0].toUpperCase())),
];
const foreign = onBranch.filter((t) => !keys.includes(t));
const shared = onBranch.some((t) => keys.includes(t));
const busy = shared ? [] : foreign.map((t) => [t, ledgerState(t)]).filter(([, s]) => s?.open);
if (busy.length) {
  say(
    'STOP',
    `checkout busy: branch ${branch} carries ${busy.map(([t, s]) => `${t} (${s.left} stage(s) left)`).join(', ')} with an open ledger — another run lives in this working copy`,
  );
} else {
  say(
    'ok',
    `branch ${branch || '(detached)'}${onBranch.length && !shared ? ' — its run is closed or halted' : ''}`,
  );
}

// ── MCP servers ──────────────────────────────────────────────────────────────────────────────────
let listed = [];
try {
  listed = Object.keys(JSON.parse(readFileSync(join(ROOT, '.mcp.json'), 'utf8')).mcpServers ?? {});
} catch {
  // no file or unreadable — below this becomes "none declared"
}
if (NEED.length === 0) {
  say(
    'note',
    `mcp declared in .mcp.json: ${listed.join(', ') || 'none'} (attached or not is visible only in the session)`,
  );
} else {
  const missing = NEED.filter((s) => !listed.some((l) => l.includes(s)));
  if (missing.length === 0)
    say('ok', `mcp: ${NEED.join(', ')} declared (attached or not is visible only in the session)`);
  else {
    const worktree = existsSync(join(ROOT, '.git')) && statSync(join(ROOT, '.git')).isFile();
    say(
      'STOP',
      `mcp: ${missing.join(', ')} not in .mcp.json${worktree ? ' — a worktree checks out the committed file' : ''}`,
    );
  }
}

// ── trunk freshness — informational: stage 2 fetches anyway ──────────────────────────────────────
try {
  const hours = (Date.now() - statSync(join(ROOT, '.git', 'FETCH_HEAD')).mtimeMs) / 3_600_000;
  say(
    'note',
    `remote last fetched ${hours < 1 ? 'under an hour' : `${Math.round(hours)}h`} ago — stage 2 fetches anyway`,
  );
} catch {
  // no FETCH_HEAD (worktree, fresh clone) — nothing to say
}

// ── resume ───────────────────────────────────────────────────────────────────────────────────────
for (const key of keys) {
  const state = ledgerState(key);
  if (!state) continue;
  if (state.halted)
    say(
      'note',
      `${key}: ledger exists, run was halted with a question — read it before anything else`,
    );
  else if (state.open)
    say('note', `${key}: ledger exists → resume at ${state.next || 'the first open stage'}`);
  else
    say(
      'note',
      `${key}: ledger exists and is complete — a re-opened ticket continues in the same file`,
    );
}

process.stdout.write(`preflight ${keys.join(',')}\n${lines.join('\n')}\n`);
process.stdout.write(
  stops
    ? `VERDICT: blocked (${stops}) — claim nothing, report the STOP lines to the user\n`
    : 'VERDICT: clear\n',
);
process.exit(stops ? 1 : 0);
