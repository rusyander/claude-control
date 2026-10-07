// Single source of truth for agent-doc policy: budgets, canonical layout, per-project opt-out.
//
// Why one module: the numbers used to live in four hooks and two docs and had already drifted
// (40 KB in one guard vs 30 KB in the doc). Any rule stated twice is a rule that will disagree
// with itself. Hooks import from here; the skill states it once and points at the enforcement.
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve, dirname, sep, join } from 'node:path';
import { STATE_DIR } from './kit-paths.mjs';

/** Normalize any path to absolute forward-slash form. */
export const norm = (p) =>
  resolve(String(p || '.'))
    .split(sep)
    .join('/');

// ---------------------------------------------------------------------------
// Budgets. Cost-based, not aesthetic: compressing costs tokens too, so the
// thresholds mark where the investment starts paying back.
// ---------------------------------------------------------------------------
export const BUDGET = {
  target: 8 * 1024, // ≤ this: fine
  ceiling: 15 * 1024, // > this: compress now
  readCap: 30 * 1024, // > this: never read whole (doc-size-guard)
  dedicated: 40 * 1024, // > this: compressing mid-task costs more than it saves — split instead
  tasksMd: 25 * 1024, // TASKS.md is human-facing prose in the user's language — its own limit
  memoryIndex: 8 * 1024, // MEMORY.md loads every session; over this, archive closed lines
  // Human docs cost the agent nothing per session — nothing here is auto-loaded, and README/docs
  // are read only when the user points at them. So the limit is readability for a person, not a
  // token budget: a doc past humanWarn is hard to navigate; past humanHard it is two documents.
  humanWarn: 40 * 1024,
  humanHard: 120 * 1024,
};

// ---------------------------------------------------------------------------
// Lifetime. ONE dead threshold for everything an agent reads (a deliberate
// decision): untouched 14 days and not durable → presumed dead, retire it.
// Working buffers get half that — they are disposable by construction.
// ---------------------------------------------------------------------------
// Names inside .agent/ that carry no `.agent.md` suffix, because rules, hooks and tools address
// them BY NAME — a suffix would break every reference. Single source on purpose: this list used to
// be copied into agent-doc-location, doc-daily-review and docs-validate, the copies drifted, and
// glossary.md ended up denied by the layout guard and flagged by the validator while CLAUDE.md
// mandated exactly that path.
export const FIXED_AGENT_NAMES = /^(PROGRESS|notes|ARCHIVE|README|TASKS|glossary)\.md$/i;

// Docs that never go stale by age: written once, then consulted. Their mtime carries no signal —
// a glossary nobody edited for a month is a settled vocabulary, not a dead file.
export const DURABLE_DOC_NAMES =
  /^(notes|PROGRESS|ARCHIVE|project-profile|MEMORY|glossary|conventions|architecture)(\.agent)?\.md$/i;

export const DEAD_D = 14;
export const TTL_D = {
  stale: DEAD_D, // agent doc untouched this long → presumed dead
  tmp: Math.round(DEAD_D / 2), // .agent/tmp: subagent reports, disposable
  screenshots: DEAD_D, // before/after shots → quarantine
  trash: DEAD_D, // quarantine → erased for good
  backup: DEAD_D, // dated backups → erased for good
  // archive/ is a waiting room, not a graveyard: a doc that has sat
  // there untouched this long is never coming back, and its one-line entry in ARCHIVE.md — which
  // is never purged — keeps the record that it existed.
  archive: DEAD_D,
};

// ---------------------------------------------------------------------------
// Canonical layout. Exactly three places may hold agent-facing material, and
// only the first two are ours to write:
//   <root>/CLAUDE.md   the ONLY auto-loaded doc — entry point, points into .agent/
//                      (or <root>/AGENTS.md: Claude Code loads it when there is no CLAUDE.md)
//   <root>/.agent/     every other agent doc (git-excluded)
//   <root>/.claude/    Claude Code's own config — location mandated by the tool
// A monorepo gets ONE of each, at the repo root. Per-package CLAUDE.md / .agent/
// fragments the context and reloads the same knowledge several times.
// ---------------------------------------------------------------------------
export const LAYOUT_RULE =
  '<root>/CLAUDE.md or <root>/AGENTS.md (entry point) + <root>/.agent/ (everything else) + <root>/.claude/ (tool config). ' +
  'One of each per repository, even in a monorepo.';

/** Nearest enclosing repository root (directory containing .git), or null. */
export function projectRoot(fromPath) {
  let dir = norm(fromPath);
  // A file path: start from its directory.
  if (/\.[a-z0-9]+$/i.test(dir)) dir = dirname(dir).split(sep).join('/');
  for (let i = 0; i < 40 && dir; i++) {
    if (existsSync(join(dir, '.git'))) return dir;
    const up = dirname(dir).split(sep).join('/');
    if (up === dir) break;
    dir = up;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Per-project opt-out. Stored GLOBALLY, never inside the project: a project the
// user told us not to touch must not receive a marker file either.
// ---------------------------------------------------------------------------
// CLAUDE_DOC_POLICY_STORE: tests only — the real store is never written by a test run.
const STORE =
  process.env.AGENTDECK_KIT_DOC_POLICY_STORE ||
  process.env.CLAUDE_DOC_POLICY_STORE ||
  join(STATE_DIR, 'doc-hygiene.json');

export function readPolicyStore() {
  try {
    const parsed = JSON.parse(readFileSync(STORE, 'utf8'));
    return parsed && typeof parsed === 'object' && parsed.projects
      ? parsed
      : { version: 1, projects: {} };
  } catch {
    return { version: 1, projects: {} };
  }
}

export function writePolicyStore(store) {
  try {
    mkdirSync(dirname(STORE), { recursive: true });
    writeFileSync(STORE, JSON.stringify(store, null, 2), 'utf8');
    return true;
  } catch {
    return false;
  }
}

/**
 * Policy for the project owning `somePath`.
 * mode 'off'    — the user said hands off: every doc-hygiene hook stays silent here.
 * mode 'strict' — default: budgets, English, canonical layout all enforced.
 * extraRoots    — repo-relative dirs the user explicitly approved as agent-doc homes.
 */
export function policyFor(somePath) {
  const root = projectRoot(somePath);
  if (!root) return { root: null, mode: 'strict', extraRoots: [] };
  const rec = readPolicyStore().projects[root.toLowerCase()];
  return {
    root,
    mode: rec?.mode === 'off' ? 'off' : 'strict',
    extraRoots: Array.isArray(rec?.extraRoots) ? rec.extraRoots : [],
    asked: Boolean(rec),
  };
}

/** True when every doc-hygiene hook must stay quiet for this path's project. */
export function hygieneDisabled(somePath) {
  return policyFor(somePath).mode === 'off';
}

/** The store path, so a hook can tell the model exactly where to record an answer. */
export const POLICY_STORE_PATH = STORE.split(sep).join('/');

// ---------------------------------------------------------------------------
// Which NAME carries a project's instructions. Claude Code reads AGENTS.md in a
// project that has no CLAUDE.md (settings key `instructionFiles`, default
// `claude-md-or-agents-md`). Every other agent CLI reads AGENTS.md already, so
// the name stopped being a given and became the user's decision: asked once
// per project, never assumed, never renamed unasked.
// Own store on purpose: `doc-policy-set <dir> strict` DELETES the hygiene
// record, and wiping one answer must not wipe an answer to another question.
// ---------------------------------------------------------------------------
const NAMING_STORE = join(STATE_DIR, 'instruction-files.json');

function readNamingStore() {
  try {
    const parsed = JSON.parse(readFileSync(NAMING_STORE, 'utf8'));
    return parsed && typeof parsed === 'object' && parsed.projects
      ? parsed
      : { version: 1, projects: {} };
  } catch {
    return { version: 1, projects: {} };
  }
}

/** 'keep' — stays CLAUDE.md · 'moved' — lives in AGENTS.md · null — never asked. */
export function instructionChoice(somePath) {
  const root = projectRoot(somePath) || norm(somePath);
  const rec = readNamingStore().projects[root.toLowerCase()];
  return rec?.choice === 'keep' || rec?.choice === 'moved' ? rec.choice : null;
}

/** Record the user's answer. Returns the project root it was stored under, or null on failure. */
export function setInstructionChoice(somePath, choice) {
  if (choice !== 'keep' && choice !== 'moved') return null;
  const root = projectRoot(somePath) || norm(somePath);
  const store = readNamingStore();
  store.projects[root.toLowerCase()] = { choice, since: new Date().toISOString().slice(0, 10) };
  try {
    mkdirSync(dirname(NAMING_STORE), { recursive: true });
    writeFileSync(NAMING_STORE, JSON.stringify(store, null, 2), 'utf8');
    return root;
  } catch {
    return null;
  }
}

/** Listing, for the tool that records answers. */
export function listInstructionChoices() {
  return Object.entries(readNamingStore().projects);
}

export const NAMING_STORE_PATH = NAMING_STORE.split(sep).join('/');
