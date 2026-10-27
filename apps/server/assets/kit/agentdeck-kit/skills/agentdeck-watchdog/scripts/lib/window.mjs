// The limit window: <app-data>/limit-runs.json, one entry per panel run (`open: true` while it still runs)
// { id, chatId, sessionId, startedAt, endedAt, tokens, samples: [{ at, fiveHour, sevenDay: { utilization, resetsAt } }] }.
// Every finished run of a watched group is a RUN line with its tokens and how far the window moved while it ran;
// the window crossing 80/90/95 % is WINDOW (hi) once per level per reset — a group that burns the window is paused
// at its safe point like any other waste (owner 25.10).
import fs from 'node:fs';
import path from 'node:path';
import { age, kc } from '../../../watchdog/scripts/lib/core.mjs';
import { appDataOf, mtime, pct, trim } from './common.mjs';

const LEVELS = [0.8, 0.9, 0.95];
// A run that moved the 5-hour window this much, the weekly one this much, or spent this many tokens is heavy.
const HEAVY = { five: 0.05, seven: 0.02, tokens: 3e6 };

const moved = (a, b) => (!a || !b ? null : a.resetsAt !== b.resetsAt ? b.utilization : b.utilization - a.utilization);
// The window before a run: the last sample of an earlier run when it is recent, else the run's own first sample.
// A sample hours old sits in an older window, and the reset since read as the whole new window spent by this one
// run (g1 26.10: «+49% while it ran» for 46 → 49 %, armed as heavy).
const RECENT = 15 * 60e3;
const startOf = (r, before) =>
  before && before.at >= (r.startedAt ?? 0) - RECENT ? before : (r.samples?.length ?? 0) > 1 ? r.samples[0] : null;

export function scanWindow(ctx, units) {
  const { o, s, emit } = ctx;
  const P = s.plugin;
  const f = path.join(appDataOf(o), 'limit-runs.json');
  const t = mtime(f);
  ctx.cover.window = !!t;
  if (!t || t === P.winMtime) return;
  let runs;
  try {
    const j = JSON.parse(fs.readFileSync(f, 'utf8'));
    runs = Array.isArray(j) ? j : (j.runs ?? []);
  } catch {
    return; // mid-write: next pass
  }
  P.winMtime = t;
  const W = (P.win ??= {});
  const seed = !W.seen;
  W.seen ??= {};
  W.level ??= {};
  const chatOf = {};
  for (const [n] of units) for (const c of P.groups?.[n]?.chats ?? []) chatOf[c] = n;
  // A stage start runs under a pending `new-*` key no group snapshot holds (g9 26.10: five stage runs, ~104M tokens,
  // fell into `other` and the heavy-run arm never saw them); its session's transcript lies in the unit's own dir.
  const bySession = {};
  const unitOf = (r) => {
    const known = chatOf[r.chatId] ?? chatOf[r.sessionId];
    if (known || !r.sessionId) return known;
    bySession[r.sessionId] ??= units.find(([, u]) => u.dir && fs.existsSync(path.join(u.dir, `${r.sessionId}.jsonl`)))?.[0] ?? '';
    return bySession[r.sessionId] || undefined;
  };
  let base = null;
  let latest = null;
  for (const r of runs.filter((x) => x.endedAt).sort((a, b) => a.endedAt - b.endedAt)) {
    const last = r.samples?.at(-1) ?? null;
    const before = base;
    if (last) base = last;
    if (last && (!latest || last.at >= latest.at)) latest = last;
    // A record written mid-run (`open`) is a sample, not the end: its endedAt is the sample time and the run goes on
    // (25.10: an open record read as a finished run, «63k tok in 20s», and the real end was never shown).
    if (r.open || W.seen[r.id]) continue;
    W.seen[r.id] = r.endedAt;
    if (seed) continue;
    const name = unitOf(r);
    if (!name) {
      W.other = (W.other ?? 0) + (r.tokens ?? 0);
      continue;
    }
    // Groups run in parallel: the move is the window's while this run ran, an upper bound of its own share.
    const from = startOf(r, before);
    const d5 = moved(from?.fiveHour, last?.fiveHour);
    const d7 = moved(from?.sevenDay, last?.sevenDay);
    const heavy = (d5 ?? 0) >= HEAVY.five || (d7 ?? 0) >= HEAVY.seven || (r.tokens ?? 0) >= HEAVY.tokens;
    const ev = emit(
      name,
      heavy ? 'hi' : 'mid',
      'RUN',
      `${kc(r.tokens ?? 0)} tok in ${age((r.endedAt ?? 0) - (r.startedAt ?? r.endedAt ?? 0))} · 5h ${pct(last?.fiveHour?.utilization)}${d5 === null ? '' : ` (+${pct(d5)} while it ran)`} · 7d ${pct(last?.sevenDay?.utilization)}${d7 === null ? '' : ` (+${pct(d7)})`}${heavy ? ' — heavy: find what it spent on (show.mjs --pack)' : ''}`,
    );
    if (heavy) {
      ev.waste = 'window';
      // The run's own session: once the group moved on to another conversation, the arm has nothing to stop.
      if (r.sessionId) ev.sid = r.sessionId;
    }
    (W.byUnit ??= {})[name] = { tokens: r.tokens ?? 0, d5, d7, at: r.endedAt };
  }
  trim(W.seen, 400);
  if (!latest) return;
  W.last = { at: latest.at, five: latest.fiveHour, seven: latest.sevenDay };
  // The window's own level is news even on first sight: it is the state now, not history. A sample whose window
  // has reset since is history: the level is unknown, not 97 % (25.10: a 24.10 19:48 sample, reset 21:00, raised
  // WINDOW 13 h later and armed a pause of every group).
  for (const [k, label] of [['five', '5-hour'], ['seven', '7-day']]) {
    const x = W.last[k];
    if (!liveWindow(x)) continue;
    const lvl = LEVELS.filter((v) => x.utilization >= v).length;
    const key = `${k}|${x.resetsAt}`;
    if (lvl > (W.level[key] ?? 0)) {
      const ev = emit('—', 'hi', 'WINDOW', `${label} window at ${pct(x.utilization)} (resets in ${age(x.resetsAt * 1000 - Date.now())}) — every running group spends the rest of it: pause the groups at their safe points, resume after the reset or on the owner's word`);
      ev.waste = 'window';
      ev.allGroups = true;
    }
    W.level[key] = Math.max(lvl, W.level[key] ?? 0);
  }
  trim(W.level, 20);
}

export function windowPart(W, name) {
  const r = W?.byUnit?.[name];
  return r ? `last run ${kc(r.tokens)} tok${r.d5 === null ? '' : ` +${pct(r.d5)} 5h`}` : '';
}
const liveWindow = (x) => !!x && x.resetsAt * 1000 > Date.now();
const level = (x) => (!x || liveWindow(x) ? pct(x?.utilization) : 'reset since the last run');
export const windowCover = (W, ok) => (!ok ? '✗ no limit-runs.json' : W?.last ? `✓ 5h ${level(W.last.five)} 7d ${level(W.last.seven)}` : '✓ no samples yet');
