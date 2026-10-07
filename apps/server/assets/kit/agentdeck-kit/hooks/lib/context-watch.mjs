// PostToolUse (any tool): keep the handoff artifact CURRENT while a long session runs, so a
// compaction — or a /clear the user issues hours later from their phone — costs nothing.
//
// Why not a "/clear reminder": the sessions that actually need this run unattended. A message
// addressed to the user sits unread while the agent keeps working at 250k context. What has to
// happen automatically is the WRITE, not the clear: PreCompact already dumps .agent/PROGRESS.md,
// but it fires once, at ~300k, possibly mid-edit. This fires early and repeatedly, so the file is
// never more than one bucket stale and auto-compact always lands on a fresh checkpoint.
//
// Cost discipline: silent below FLOOR, and above it at most once per BUCKET of growth — a stamp
// file keyed by session + bucket. Worst case over a session that runs 150k -> 400k: 10 messages.
// Reads the usage blocks of a Claude-shaped transcript; on a CLI whose transcript carries none it
// stays silent. Kill-switch: AGENTDECK_KIT_CONTEXT_WATCH=0 (CLAUDE_CONTEXT_WATCH=0 too).
import { existsSync, writeFileSync, openSync, readSync, fstatSync, closeSync } from 'node:fs';
import { join } from 'node:path';
import { stateDir } from './kit-paths.mjs';

const FLOOR = 150_000; // below this the session is cheap; saying anything is pure overhead
const BUCKET = 25_000; // one message per this much growth
const URGENT = 260_000; // auto-compact is close — stop deferring the write

/** @returns {string|null} one short instruction, or null. */
export default function contextWatch(input) {
  if (process.env.AGENTDECK_KIT_CONTEXT_WATCH === '0' || process.env.CLAUDE_CONTEXT_WATCH === '0')
    return null;
  const path = String(input?.transcript_path ?? '');
  if (!path || !existsSync(path)) return null;

  const ctx = lastContextTokens(path);
  if (!ctx || ctx < FLOOR) return null;

  const bucket = Math.floor(ctx / BUCKET);
  const session = String(input?.session_id ?? 'x').slice(0, 12);
  if (alreadySent(session, bucket)) return null;

  const k = Math.round(ctx / 1000);
  if (ctx >= URGENT) {
    return (
      `[context-watch] ctx ${k}k, auto-compact near. NOW, before the next step, update ` +
      `.agent/PROGRESS.md: done+verified / in progress / left+blockers / decisions / key paths / ` +
      `next skills. After compaction only that file survives. Specs and diffs by path, not content. ` +
      `Then continue the task.`
    );
  }
  return (
    `[context-watch] ctx ${k}k, re-billed whole on every request. Refresh .agent/PROGRESS.md ` +
    `(done / in progress / left / decisions / paths), briefly, files by path, then carry on at full ` +
    `depth — this counter is not a deadline. Task closed → tell the user plainly, in their language: ` +
    `continuing is cheaper after /clear.`
  );
}

/**
 * Last assistant usage in the transcript = the context the next request will re-bill.
 * Read only the tail: these files reach tens of MB and this runs after every tool call.
 */
function lastContextTokens(path) {
  let fd;
  try {
    fd = openSync(path, 'r');
    const size = fstatSync(fd).size;
    const len = Math.min(512 * 1024, size);
    const buf = Buffer.alloc(len);
    readSync(fd, buf, 0, len, size - len);
    const tail = buf.toString('utf8');
    let best = null;
    // Scan every usage block in the tail; the last complete one wins.
    for (const m of tail.matchAll(/"usage"\s*:\s*\{[^}]*?(?:\{[^}]*\}[^}]*?)*\}/g)) {
      try {
        const u = JSON.parse(`{${m[0]}}`).usage;
        const total =
          (u.input_tokens || 0) +
          (u.cache_read_input_tokens || 0) +
          (u.cache_creation_input_tokens ||
            (u.cache_creation?.ephemeral_5m_input_tokens ?? 0) +
              (u.cache_creation?.ephemeral_1h_input_tokens ?? 0) ||
            0);
        if (total > 0) best = total;
      } catch {
        /* a clipped block at the tail edge is expected — keep the previous one */
      }
    }
    return best;
  } catch {
    return null;
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        /* nothing to do */
      }
    }
  }
}

function alreadySent(session, bucket) {
  const dir = stateDir('stamps');
  if (!dir) return true;
  const stamp = join(dir, `ctxwatch-${session}-${bucket}.stamp`);
  if (existsSync(stamp)) return true;
  try {
    writeFileSync(stamp, '1');
  } catch {
    return true; // cannot throttle → stay silent rather than repeat on every tool call
  }
  return false;
}
