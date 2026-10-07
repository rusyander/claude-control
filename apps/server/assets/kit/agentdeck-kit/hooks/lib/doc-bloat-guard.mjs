// Bloat guard for agent docs (PostToolUse on Write|Edit). Mechanical part (size) here; the
// semantic part (compress) goes back to the model as an immediate instruction. Silent while the
// doc is within budget. Fires AT WRITE TIME, not weeks later.
import { statSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { STATE_DIR } from './kit-paths.mjs';
import { isAgentDoc, norm } from './agent-doc.mjs';
import { BUDGET, hygieneDisabled } from './doc-policy.mjs';

// Repeating the same warning on every write of a file that is already known to be over budget
// costs tokens and teaches the model to ignore the guard. Nag once per size plateau: again only
// when the file GREW by >5% since the last nag. The daily review stays the recurring reminder.
const SEEN_PATH = join(STATE_DIR, 'doc-bloat-seen.json');

function readSeen() {
  try {
    return JSON.parse(readFileSync(SEEN_PATH, 'utf8')) ?? {};
  } catch {
    return {};
  }
}

/** True when this size at this path was already reported and the file has not grown since. */
function alreadyNagged(p, size) {
  const seen = readSeen();
  const prev = Number(seen[p] ?? 0);
  if (prev && size <= prev * 1.05) return true;
  seen[p] = size;
  try {
    // Bound the cache: entries are only useful while a file stays oversized.
    const keys = Object.keys(seen);
    if (keys.length > 500) for (const k of keys.slice(0, keys.length - 400)) delete seen[k];
    mkdirSync(dirname(SEEN_PATH), { recursive: true });
    writeFileSync(SEEN_PATH, JSON.stringify(seen));
  } catch {
    /* cache is an optimization; failing to persist just means one extra nag */
  }
  return false;
}

// Cost-based thresholds, not size alone: compressing costs tokens itself (read + rewrite),
// so over-eager auto-compression can lose money. Numbers live in doc-policy.mjs — one source.
const SMELL = BUDGET.target; // cheap to fix in passing
const ACT = BUDGET.ceiling; // compress now: the investment pays back
const TOO_BIG = BUDGET.dedicated; // compressing on the fly costs MORE than leaving it: dedicated pass

export default function docBloatGuard(input) {
  const filePath = String(input?.tool_input?.file_path ?? '');
  if (!filePath || !/\.md$/i.test(filePath)) return null;
  if (hygieneDisabled(filePath)) return null; // user said hands off this project
  const p = norm(filePath);
  const name = filePath.split(/[\\/]/).pop();

  // TASKS.md — human-facing (never translated) but must hold ONLY open tasks or it grows forever.
  if (/\/TASKS\.md$/i.test(p)) {
    let sz;
    try {
      sz = statSync(filePath).size;
    } catch {
      return null;
    }
    if (sz <= BUDGET.tasksMd) return null;
    if (alreadyNagged(p, sz)) return null;
    return (
      `[doc-bloat-guard] TASKS.md = ${Math.round(sz / 1024)} KB — closed tasks were left inline. ` +
      `Move delivered/accepted task blocks to .agent/archive/TASKS-done-<YYYY-MM-DD>.md, keep ONLY open tasks. ` +
      `Keep it in the user's language (human-facing) — do NOT translate. Never delete the file. ` +
      `Never read it whole: Grep the task, then Read with offset/limit. Rules: skill doc-hygiene.`
    );
  }

  // MEMORY.md — the memory index: loads EVERY session, so its budget is lines + absence of
  // closed entries (those belong in ARCHIVE.md), not file size.
  if (/\/memory\/MEMORY\.md$/i.test(p)) {
    let text;
    try {
      text = readFileSync(filePath, 'utf8');
    } catch {
      return null;
    }
    const entries = text.split('\n').filter((l) => /^- \[/.test(l));
    const closed = entries.filter((l) => {
      const hook = l.split(/\)\s+—\s+/)[1] ?? '';
      return /(^|[^\w])(DONE|merged|shipped|superseded|historical)([^\w]|$)/i.test(hook);
    });
    const msgs = [];
    if (closed.length)
      msgs.push(
        `${closed.length} closed-looking entr${closed.length === 1 ? 'y' : 'ies'} (DONE/merged/…) — move to ARCHIVE.md now`,
      );
    if (entries.length > 60)
      msgs.push(`${entries.length} entries (soft cap 60) — archive or merge`);
    if (!msgs.length) return null;
    return (
      `[doc-bloat-guard] MEMORY.md loads EVERY session: ${msgs.join('; ')}. ` +
      `One-line hooks only; bodies live in memory files. Report to the user in their language, one line.`
    );
  }

  if (!isAgentDoc(filePath)) return null;
  // Live working buffers grow on purpose and are cleaned by their own cycle.
  if (/\/\.agent\/tmp\//.test(p) || /\/\.trash\//.test(p) || /\/archive\//.test(p)) return null;

  let size;
  try {
    size = statSync(filePath).size;
  } catch {
    return null;
  }
  if (size <= SMELL) return null;
  if (alreadyNagged(p, size)) return null;

  const kb = Math.round(size / 1024);
  let level;
  let what;
  if (size > TOO_BIG) {
    level = 'WAY OVER';
    // Deferring a giant doc is how 3000-line files survive for years. The escape is triage by
    // METADATA, which costs nothing: a dead doc is retired without ever being read.
    what =
      'TRIAGE NOW, do not defer (reading it whole would cost ' +
      `≈${Math.round((size / 1024 / 2.5) * 1.2)}k tokens — so do not read it whole). ` +
      'Decide from name, headings (Grep "^#"), mtime and git: ' +
      'closed/superseded/obsolete → move the WHOLE file to archive/ + one line in ARCHIVE.md, no reading; ' +
      'still live → split by topic into ≤15 KB files this session, or write an explicit task into ' +
      '.agent/PROGRESS.md. Ending the turn with neither is a rule violation.';
  } else if (size > ACT) {
    level = 'OVER';
    what =
      'Compress NOW (the investment pays back): closed → ARCHIVE.md/archive/, ' +
      'live → telegraphic English, superseded → replace rather than stack.';
  } else {
    level = 'at the limit';
    what = 'Prune in passing on next touch: cut filler, move closed items to archive.';
  }

  return (
    `[doc-bloat-guard] ${name} = ${kb} KB — agent-doc budget ${level} ` +
    `(target ≤${BUDGET.target / 1024} KB, ceiling ${BUDGET.ceiling / 1024} KB). ${what} ` +
    `Rules: skill doc-hygiene, Mode A. Report to the user in their language, one line.`
  );
}
