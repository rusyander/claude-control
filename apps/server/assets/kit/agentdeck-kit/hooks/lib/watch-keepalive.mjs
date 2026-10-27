// Stop item `watch-keepalive`: a coordinator watch keeps its session's turn alive. The kit's watchdog skill
// registers the session in <kit state>/watchers/<session_id>.json (skills/watchdog/scripts/lib/keepalive.mjs —
// a kit copy writes there, a personal copy in <config>/cache/watchers); while that entry is live, ending the turn
// is blocked with the exact command of the next watch call — a coordinator that ends its turn leaves every
// watched group unwatched.
//
// The turn ends only on: the user's quoted stop (`--stop "<words>"` removes the entry after checking the words
// are in the user's own messages), <repo>/.agent/live-watch/hold.json, or `allDone` (every group done/failed).
// `stop_hook_active` is deliberately NOT honoured — a keepalive that yields after one block keeps nothing alive.
// The bound is its own: MAX_BLOCKS blocks without a fresh watch call, then it yields until the next call re-arms
// it; an entry untouched for STALE_MS is a dead watch and is removed.
//
// One block per turn end: the personal layer may carry the same guard (<config>/hooks/lib/watch-keepalive.mjs)
// over its own registry. Each guard reads only its own registry, and this one also stays silent while the
// personal guard is installed and holds a live entry for the same session.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { stateDir } from './kit-paths.mjs';
import { inSubagent } from './transcript.mjs';

const MAX_BLOCKS = 3;
const STALE_MS = 12 * 3600e3;
// A watch call returns within 2 min (watchdog DEFAULTS.max); none for this long while the turn goes on = dead.
const DEAD_MS = 10 * 60e3;

const age = (ms) =>
  ms < 90e3
    ? `${Math.round(ms / 1e3)}s`
    : ms < 5400e3
      ? `${Math.round(ms / 60e3)}m`
      : `${(ms / 3600e3).toFixed(1)}h`;
const fileName = (sid) => `${String(sid).replace(/[^\w.-]/g, '_')}.json`;
const configRoot = () => process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');

function readRec(f) {
  try {
    return JSON.parse(fs.readFileSync(f, 'utf8'));
  } catch {
    return null;
  }
}

/** The personal guard is installed and holds a live entry for this session: it blocks, this one stays silent. */
export function personalHolds(sid, root = configRoot(), now = Date.now()) {
  if (!fs.existsSync(path.join(root, 'hooks', 'lib', 'watch-keepalive.mjs'))) return false;
  const rec = readRec(path.join(root, 'cache', 'watchers', fileName(sid)));
  return Boolean(rec && !rec.stopped && now - (rec.at ?? 0) <= STALE_MS);
}

/** This session's entry in the kit registry: { f, rec } or null. */
function entryOf(input) {
  const sid = input?.session_id;
  if (!sid || inSubagent(input)) return null;
  const dir = stateDir('watchers');
  if (!dir) return null;
  const f = path.join(dir, fileName(sid));
  const rec = readRec(f);
  return rec ? { f, rec, sid } : null;
}

const held = (rec) =>
  Boolean(rec.repo && fs.existsSync(path.join(rec.repo, '.agent', 'live-watch', 'hold.json')));

/**
 * post-any: the Stop guard acts only at turn end, but a coordinator can keep its turn busy with other work for half
 * an hour while nobody watches. Any tool call of the registered session with no watch call for DEAD_MS gets one line
 * naming the next watch command; at most once per DEAD_MS (`alarmAt`). Silent in subagents.
 */
export function watchDeadAlarm(input) {
  const e = entryOf(input);
  if (!e) return null;
  const { f, rec, sid } = e;
  const now = Date.now();
  if (rec.stopped || rec.allDone || !rec.cmd || now - (rec.at ?? 0) > STALE_MS || held(rec))
    return null;
  if (personalHolds(sid, configRoot(), now)) return null;
  const idle = now - (rec.at ?? now);
  if (idle < DEAD_MS || now - (rec.alarmAt ?? 0) < DEAD_MS) return null;
  rec.alarmAt = now;
  fs.writeFileSync(f, `${JSON.stringify(rec, null, 1)}\n`);
  const live = (rec.live ?? []).join(', ') || 'its units';
  return `[watch-keepalive] WATCH DEAD: no watch call for ${age(idle)} over ${live} — every group runs unseen; finish this step, then resume now: ${rec.cmd}`;
}

/** stop: block the turn end while the watch is live. */
export default function watchKeepalive(input) {
  const e = entryOf(input);
  if (!e) return null;
  const { f, rec, sid } = e;
  const now = Date.now();
  if (rec.stopped || now - (rec.at ?? 0) > STALE_MS) {
    fs.rmSync(f, { force: true });
    return null;
  }
  if (rec.allDone || held(rec)) return null;
  if (personalHolds(sid, configRoot(), now)) return null;
  if ((rec.blocks ?? 0) >= MAX_BLOCKS) return null;
  rec.blocks = (rec.blocks ?? 0) + 1;
  fs.writeFileSync(f, `${JSON.stringify(rec, null, 1)}\n`);
  const live = (rec.live ?? []).join(', ') || 'its units';
  return {
    decision: 'block',
    reason:
      `[watch-keepalive] the live watch over ${live} is on, last call ${age(now - (rec.at ?? now))} ago — row every flag of the last digest, then run it again now: ${rec.cmd}\n` +
      `The turn ends only on: the user's stop (same command + --stop "<the user's words, quoted from their message>"), ` +
      `hold.json in ${rec.repo}/.agent/live-watch, or every group done/failed. Block ${rec.blocks}/${MAX_BLOCKS} without a new watch call.`,
  };
}
