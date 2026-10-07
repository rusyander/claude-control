// SessionStart: automatic cleanup of agent artifacts in the project's `.agent/` folders.
//
// HARD SAFETY BOUNDARIES:
//  - touches ONLY paths inside `.agent/` (re-checked before every operation);
//    `.agent/` is in .git/info/exclude by convention → no git-tracked work lives there;
//  - NEVER: files at the root of .agent/ (PROGRESS.md, notes.md, ARCHIVE.md — the index of what
//    was archived survives everything);
//  - screenshots/artifacts are not erased outright — they go to .agent/.trash/<date>/
//    (recoverable) and only from there are purged after TRASH_TTL_D days;
//  - tmp/ = disposable subagent reports by our own convention → purged after TMP_TTL_D days (7).
//    A report worth keeping must be MOVED to .agent/archive/, which buys it ARCHIVE_TTL_D more
//    days; past that it is erased too — archive/ is a waiting room, not a graveyard;
//  - operation ceiling + kill-switch AGENTDECK_KIT_DOC_AUTOCLEAN=0 (CLAUDE_DOC_AUTOCLEAN=0 too);
//  - any error is swallowed: session start must never fail because of cleanup.
import { readdirSync, statSync, existsSync, rmSync, mkdirSync, renameSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { BUDGET, TTL_D, hygieneDisabled } from './doc-policy.mjs';
import { reviewInventory } from './doc-daily-review.mjs';

// Every TTL comes from one place (doc-policy.mjs, TTL_D): a single 14-day death
// threshold for everything the agent reads; tmp lives half as long — it is a disposable buffer.
const DAY = 864e5;
const TMP_TTL_D = TTL_D.tmp;
const SHOT_TTL_D = TTL_D.screenshots; // screenshots: older → quarantine (recoverable)
const TRASH_TTL_D = TTL_D.trash; // quarantine: older → erase for good
const BACKUP_TTL_D = TTL_D.backup; // backup/: older → erase for good
const ARCHIVE_TTL_D = TTL_D.archive; // archive/: sat unused → erase; the ARCHIVE.md line survives
const MAX_OPS = 5000;

let NOW = Date.now();
let ops = 0;
let tmpDeleted = 0;
let quarantined = 0;
let purged = 0;
let freedBytes = 0;
let bigDocs = [];

const norm = (p) => resolve(p).split(sep).join('/');
/** Allow an operation ONLY when the path sits inside some `.agent/`. */
const insideAgent = (p) => `${norm(p)}/`.includes('/.agent/');

function sizeOf(p) {
  try {
    const st = statSync(p);
    if (st.isFile()) return st.size;
    let s = 0;
    for (const e of readdirSync(p, { withFileTypes: true })) s += sizeOf(join(p, e.name));
    return s;
  } catch {
    return 0;
  }
}

function newestMtime(p) {
  try {
    const st = statSync(p);
    if (st.isFile()) return st.mtimeMs;
    let m = st.mtimeMs;
    for (const e of readdirSync(p, { withFileTypes: true })) {
      m = Math.max(m, newestMtime(join(p, e.name)));
    }
    return m;
  } catch {
    return NOW; // cannot tell — treat as fresh, leave it alone
  }
}

function hardRemove(p) {
  if (!insideAgent(p) || ops++ > MAX_OPS) return false;
  const sz = sizeOf(p);
  try {
    rmSync(p, { recursive: true, force: true });
    freedBytes += sz;
    return true;
  } catch {
    return false;
  }
}

function moveToTrash(root, p) {
  if (!insideAgent(p) || ops++ > MAX_OPS) return false;
  const stamp = new Date(NOW).toISOString().slice(0, 10);
  const dest = join(root, '.trash', stamp);
  try {
    mkdirSync(dest, { recursive: true });
    renameSync(p, join(dest, `${Date.now().toString(36)}-${p.split(sep).pop()}`));
    return true;
  } catch {
    return false; // cross-volume rename etc. — just skip
  }
}

function cleanRoot(root) {
  // 1. tmp/ — disposable, delete for good
  const tmp = join(root, 'tmp');
  if (existsSync(tmp)) {
    for (const e of readdirSync(tmp, { withFileTypes: true })) {
      const p = join(tmp, e.name);
      try {
        if (NOW - newestMtime(p) > TMP_TTL_D * DAY && hardRemove(p)) tmpDeleted += 1;
      } catch {
        /* skip */
      }
    }
  }

  // 2. Old before/after screenshots → quarantine (recoverable)
  const shots = join(root, 'screenshots', 'before-after');
  if (existsSync(shots)) {
    for (const e of readdirSync(shots, { withFileTypes: true })) {
      if (!e.isDirectory()) continue;
      const p = join(shots, e.name);
      try {
        if (NOW - newestMtime(p) > SHOT_TTL_D * DAY && moveToTrash(root, p)) quarantined += 1;
      } catch {
        /* skip */
      }
    }
  }

  // 2b. Dated backups (pre-delete etc.) past TTL — erase for good
  // (a backup of deleted content is dead weight; 2 weeks is the time to change your mind)
  const backup = join(root, 'backup');
  if (existsSync(backup)) {
    for (const e of readdirSync(backup, { withFileTypes: true })) {
      const p = join(backup, e.name);
      try {
        if (NOW - newestMtime(p) > BACKUP_TTL_D * DAY && hardRemove(p)) purged += 1;
      } catch {
        /* skip */
      }
    }
  }

  // 2c. archive/ past TTL — erase for good.
  // Deleted PER ENTRY by content freshness: a file just placed there survives the pass, one that
  // sat for two weeks does not. ARCHIVE.md at the .agent/ root is never touched, so the record
  // that the document existed remains.
  const archive = join(root, 'archive');
  if (existsSync(archive)) {
    for (const e of readdirSync(archive, { withFileTypes: true })) {
      if (/^ARCHIVE\.md$/i.test(e.name)) continue;
      const p = join(archive, e.name);
      try {
        if (NOW - newestMtime(p) > ARCHIVE_TTL_D * DAY && hardRemove(p)) purged += 1;
      } catch {
        /* skip */
      }
    }
  }

  // 3. Quarantine past TTL — erase for good
  const trash = join(root, '.trash');
  if (existsSync(trash)) {
    for (const e of readdirSync(trash, { withFileTypes: true })) {
      const p = join(trash, e.name);
      try {
        if (NOW - newestMtime(p) > TRASH_TTL_D * DAY && hardRemove(p)) purged += 1;
      } catch {
        /* skip */
      }
    }
  }

  // 4. Bloated docs — cannot be auto-fixed (that is content), only flagged
  const scan = (dir, depth) => {
    if (depth > 5) return;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      // backup/ is dead weight until auto-cleanup; its size costs no tokens — do not flag
      if (e.name === '.trash' || e.name === 'archive' || e.name === 'backup') continue;
      const p = join(dir, e.name);
      if (e.isDirectory()) {
        scan(p, depth + 1);
        continue;
      }
      if (!/\.md$/i.test(e.name)) continue;
      try {
        const sz = statSync(p).size;
        if (sz > 30 * 1024) bigDocs.push(`${e.name} ${Math.round(sz / 1024)}KB`);
      } catch {
        /* skip */
      }
    }
  };
  scan(root, 0);
}

/** @returns {string|null} what was cleaned and flagged, or null when there was nothing to say. */
export default function docHygieneAutoclean(input) {
  if (process.env.AGENTDECK_KIT_DOC_AUTOCLEAN === '0' || process.env.CLAUDE_DOC_AUTOCLEAN === '0')
    return null;
  const cwd = String(input?.cwd || process.cwd());
  if (hygieneDisabled(cwd)) return null; // the user said hands off this project
  NOW = Date.now();
  ops = tmpDeleted = quarantined = purged = freedBytes = 0;
  bigDocs = [];
  try {
    const roots = [];
    if (existsSync(join(cwd, '.agent'))) roots.push(join(cwd, '.agent'));
    for (const e of readdirSync(cwd, { withFileTypes: true })) {
      if (e.isDirectory() && !e.name.startsWith('.') && e.name !== 'node_modules') {
        const p = join(cwd, e.name, '.agent');
        if (existsSync(p)) roots.push(p);
      }
    }
    for (const r of roots) cleanRoot(r);
  } catch {
    return null;
  }

  // 5. Always-loaded indexes are content: cannot be auto-fixed, only flagged when over budget.
  const indexAlerts = [];
  try {
    const tasks = join(cwd, 'TASKS.md');
    if (existsSync(tasks)) {
      const kb = Math.round(statSync(tasks).size / 1024);
      const lim = BUDGET.tasksMd / 1024;
      if (kb > lim)
        indexAlerts.push(
          `TASKS.md ${kb}KB (>${lim}) — delivered → .agent/archive/, compress closed decision blocks`,
        );
    }
  } catch {
    /* a signal is no reason to break session start */
  }

  // Daily revision, without waiting for someone to edit an agent doc. Shares the `.last-review`
  // stamp with the PostToolUse path — at most one revision per day, whichever fires first.
  let review = null;
  try {
    review = reviewInventory();
  } catch {
    /* revision is a nicety; session start must never fail because of it */
  }

  const out = [];
  if (tmpDeleted) out.push(`tmp purged: ${tmpDeleted}`);
  if (quarantined) out.push(`screenshots quarantined: ${quarantined}`);
  if (purged) out.push(`trash purged: ${purged}`);
  if (freedBytes > 1048576) out.push(`freed ${Math.round(freedBytes / 1048576)} MB`);
  if (indexAlerts.length) out.push(...indexAlerts);
  if (bigDocs.length) {
    const head = bigDocs.slice(0, 3).join(', ');
    out.push(
      `docs >30KB (compress by hand): ${head}${bigDocs.length > 3 ? ` +${bigDocs.length - 3}` : ''}`,
    );
  }
  const text = [out.length ? `[doc-hygiene] ${out.join('; ')}` : '', review ?? '']
    .filter(Boolean)
    .join('\n');
  return text || null;
}
