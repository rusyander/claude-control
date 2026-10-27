// Dev-server restarts: the pending restart (dev-restart.json waits for runs), a forced one (dev-restart.request),
// and the dev-watch log — every restart named with its cause and who made it, plus the hourly rate (STORM).
// 24.10: 362 restarts a day, one per agent save; a restart kills or stalls every live run of the panel.
import fs from 'node:fs';
import path from 'node:path';
import { normP, one } from '../../../watchdog/scripts/lib/core.mjs';
import { appDataOf, low, mtime, readFrom } from './common.mjs';

// Restarts per hour at which the restart itself is the defect (lowered 25.10 from 6: three an hour already cost
// every group a run).
export const RESTART_STORM = 3;
const EDIT_WINDOW_MS = 10 * 60e3;

/** Who edited the file that triggered a restart: a watched group (its Edit/Write within 10 min) or nobody watched. */
function attribute(s, file, at) {
  const f = normP(file.trim());
  const by = Object.entries(s.units)
    .filter(([, u]) => (u.editFiles ?? []).some((x) => x.f === f && at - x.at >= -5e3 && at - x.at <= EDIT_WINDOW_MS))
    .map(([n]) => n);
  return by.length ? { by, text: `edited by ${by.join(', ')}` } : { by: [], text: 'edited by no watched group — the coordinator or another session' };
}

export function scanRestarts(ctx, units) {
  const { o, s, emit } = ctx;
  const P = s.plugin;
  const ad = appDataOf(o);
  const rj = path.join(ad, 'dev-restart.json');
  // dev-watch rewrites the file while it waits, so the CONTENT (since, files, runs) decides, never the mtime.
  const rt = mtime(rj);
  if (rt !== (ctx.restartMtime ?? -1)) {
    ctx.restartMtime = rt;
    let r;
    try {
      r = rt ? JSON.parse(fs.readFileSync(rj, 'utf8')) : null;
    } catch {
      r = undefined; // mid-write: next pass
    }
    if (r !== undefined) {
      const runs = (r?.runs ?? []).map(String);
      // The same pending restart growing by files no watched group edited (fix agents, the coordinator) is one
      // event: only who waits, and a watched group's own file, re-raise it (26.10: #—:32–37, one restart, six hi wakes).
      const now = Date.now();
      const owned = (r?.files ?? []).filter((x) => attribute(s, String(x), now).by.length).map((x) => normP(String(x)).toLowerCase());
      // Who waits = the WATCHED copies in the wait; the reason (runs ↔ checks) and unwatched runs flip with every
      // test a group starts (26.10 #—:41–43: one pending restart, three refs) and are no news.
      const waiting = units
        .filter(([, u]) => u.copy && runs.some((x) => low(u.copy).includes(low(x)) || low(x).includes(low(u.copy))))
        .map(([n]) => n)
        .sort();
      const key = r ? `${r.since}|${waiting.join(',')}|${[...new Set(owned)].sort().join(',')}` : '';
      const was = P.restartKey;
      P.restartKey = key;
      if (was !== undefined && was !== key) {
        if (!r) emit('—', 'mid', 'RESTART', 'pending restart cleared (dev-restart.json gone)');
        else {
          const ours = units.some(([, u]) => u.copy && runs.some((x) => low(u.copy).includes(low(x)) || low(x).includes(low(u.copy))));
          const files = (r.files ?? []).slice(0, 3).map((x) => `${path.basename(String(x))} (${attribute(s, String(x), Date.now()).text})`);
          emit('—', ours ? 'hi' : 'mid', 'RESTART', `server restart pending since ${r.since ?? '?'} (${r.files?.length ?? 0} files: ${one(files.join(', '), 160)}), waits for ${r.waitingFor ?? '?'}: ${one(runs.join(', '), 120)}${ours ? ' — includes a watched copy' : ''}`);
        }
      }
    }
  }
  const rq = mtime(path.join(ad, 'dev-restart.request'));
  if (rq !== (P.requestMtime ?? 0)) {
    if (rq && P.requestMtime !== undefined) emit('—', 'hi', 'RESTART', 'dev-restart.request written — the server restarts now, live runs are not waited for');
    P.requestMtime = rq;
  }
  scanDevlog(ctx);
}

function scanDevlog(ctx) {
  const { o, s, emit } = ctx;
  const P = s.plugin;
  const log = path.join(appDataOf(o), 'dev-watch.log');
  let size = -1;
  try {
    size = fs.statSync(log).size;
  } catch {
    /* no dev-watch → COVER ✗ */
  }
  ctx.cover.devlog = size >= 0;
  if (size < 0) return;
  const now = Date.now();
  const seed = P.devlogOff === undefined || size < P.devlogOff;
  // First sight: the last 256 KB give the hourly rate already running, nothing is relayed.
  const from = seed ? Math.max(0, size - 256 * 1024) : P.devlogOff;
  const chunk = readFrom(log, from, 256 * 1024);
  P.devlogOff = chunk ? from + chunk.used : seed ? size : P.devlogOff;
  P.restartAt = (P.restartAt ?? []).filter((t) => now - t < 3600e3);
  if (!chunk) return;
  // Restarts of one pass, grouped by who caused them: one line per cause, never one per save.
  const byCause = new Map();
  for (const l of chunk.text.split('\n')) {
    const crash = /упал|exited|error/i.test(l);
    // A deferral («перезапуск … отложен») and a skipped restart («перезапуск не нужен», mustfail file back) are no restart.
    const restart = /перезапуск|restart/i.test(l) && !/снята|cleared|отложен|не нужен|deferred|not needed/i.test(l);
    if (!crash && !restart) continue;
    const t = Date.parse(l.slice(0, 24));
    const at = Number.isFinite(t) ? t : now;
    if (restart && now - at < 3600e3) P.restartAt.push(at);
    if (seed) continue;
    if (crash) {
      emit('—', 'hi', 'RESTART', one(l, 170));
      continue;
    }
    // Every restart is named with its cause: the file (and who edited it) or the request.
    const m = /перезапуск:\s*(.+)$|restart(?:ing)?:\s*(.+)$/i.exec(l);
    const cause = m ? attribute(s, m[1] ?? m[2], at) : { by: [], text: /просьб|request/i.test(l) ? 'requested (dev-restart.request)' : 'cause not in the log line' };
    const c = byCause.get(cause.text) ?? { cause, n: 0, last: '' };
    c.n += 1;
    c.last = l;
    byCause.set(cause.text, c);
  }
  for (const { cause, n, last } of byCause.values()) {
    const ev = emit(cause.by[0] ?? '—', cause.by.length ? 'hi' : 'mid', 'RESTART', `${n} restart(s), last: ${one(last.replace(/^\d{4}-\d\d-\d\dT[\d:.]+Z?\s*/, ''), 130)} — ${cause.text}`);
    // A group whose own edit restarts the panel stalls every other run: waste, it arms that group's pause.
    if (cause.by.length) ev.waste = 'restart';
  }
  if (P.restartAt.length >= RESTART_STORM && now - (P.stormAt ?? 0) > 30 * 60e3) {
    P.stormAt = now;
    emit('—', 'hi', 'STORM', `${P.restartAt.length} server restarts in the last hour — each one stalls every live run; find what saves into the served tree`);
  }
}
