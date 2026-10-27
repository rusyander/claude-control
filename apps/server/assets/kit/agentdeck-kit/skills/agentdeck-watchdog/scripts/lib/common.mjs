// Shared helpers of the AgentDeck group watch: the panel's data dir and tail reads of its feeds.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { configRoot, nativePath } from '../../../watchdog/scripts/lib/core.mjs';
import { kitRoot, kitStateDir } from '../../../watchdog/scripts/lib/where.mjs';

export const KEYS_KEPT = 300;
export const low = (x) => String(x ?? '').replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
export const within = (p, root) => {
  const a = low(p);
  const b = low(root);
  return !!a && !!b && (a === b || a.startsWith(`${b}/`));
};
export const trim = (m, keep = KEYS_KEPT) => {
  const k = Object.keys(m);
  for (const x of k.slice(0, Math.max(0, k.length - keep))) delete m[x];
};
export const ring = (list, item, keep = KEYS_KEPT) => {
  list.push(item);
  if (list.length > keep) list.splice(0, list.length - keep);
  return list;
};
/** Complete lines from byte `from`, at most `max` bytes: { text, used } or null. */
export function readFrom(f, from, max) {
  const len = Math.min(fs.statSync(f).size - from, max);
  if (len <= 0) return null;
  const b = Buffer.alloc(len);
  const fd = fs.openSync(f, 'r');
  fs.readSync(fd, b, 0, len, from);
  fs.closeSync(fd);
  const last = b.lastIndexOf(0x0a);
  return last < 0 ? null : { text: b.subarray(0, last).toString('utf8'), used: last + 1 };
}
/**
 * The panel's data dir: --app-data, else what plugin.prepare discovered (lib/panel.mjs, kept in `_appData` so the
 * next-call command never carries a guess as a flag), else <config root>/agentdeck.
 */
export const appDataOf = (o) => path.resolve(nativePath(o['app-data'] ?? o._appData ?? path.join(configRoot(o), 'agentdeck')));
export const mtime = (f) => {
  try {
    return fs.statSync(f).mtimeMs;
  } catch {
    return 0;
  }
};
export const pct = (x) => `${Math.round((x ?? 0) * 100)}%`;

// The coordinator's review-spawn budget, read where the guard keeps it (hooks/lib/review-spawn.mjs: 40 per session,
// counter `review-spawns-<sid12>.txt`). Past the cap a spawn falls to spawn-cost-guard's ask — a dialog nobody
// answers mid-watch stops the loop — unless the owner's chat grant (`spawn-<sid>.json` in the grant store) still runs.
// Personal layer: <home>/.claude/cache (+ its grant store); a kit copy: the kit hooks' state dir — counter under
// `stamps/`, grant store beside it — the files the kit's own review-spawn and spawn-grant write.
export const REVIEW_CAP = 40;
export function reviewBudget(sid = process.env.CLAUDE_CODE_SESSION_ID || '', home = process.env.USERPROFILE || process.env.HOME || os.homedir(), now = Date.now(), kit = !!kitRoot()) {
  if (!sid) return '';
  const cache = kit ? kitStateDir() : path.join(home, '.claude', 'cache');
  let used = 0;
  try {
    used = Number(fs.readFileSync(path.join(cache, kit ? 'stamps' : '', `review-spawns-${sid.slice(0, 12)}.txt`), 'utf8')) || 0;
  } catch {
    /* no review spawn yet */
  }
  if (used < REVIEW_CAP) return `review budget ${REVIEW_CAP - used}/${REVIEW_CAP} left`;
  let until = 0;
  try {
    until = Date.parse(JSON.parse(fs.readFileSync(path.join(cache, 'grants', `spawn-${sid.replace(/[^a-zA-Z0-9-]/g, '')}.json`), 'utf8')).until) || 0;
  } catch {
    /* no grant */
  }
  return until > now
    ? `review cap ${REVIEW_CAP} reached, the owner's spawn grant runs ${Math.round((until - now) / 60e3)} min more`
    : `review cap ${REVIEW_CAP} reached, no grant: run the pack and audit it yourself (no spawn), or the owner types «агенты без вопроса на N ч»`;
}
/** The watched group units of a state: [name, unit] pairs. */
export const groupUnits = (s) => Object.entries(s.units).filter(([, u]) => u.group);
