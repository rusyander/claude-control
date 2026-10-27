// Legend = the verify-ledger feed (the owner's word, NOT the panel's rule texts): per watched copy, checks
// recorded, replayed, narrowed, refused. First sight reads the whole feed quietly (the copy's history so far),
// later passes flag every run the legend should have spared — and every check that ran past it (GAP).
import fs from 'node:fs';
import path from 'node:path';
import { age, one } from '../../../watchdog/scripts/lib/core.mjs';
import { appDataOf, low, readFrom, ring, trim, within } from './common.mjs';

// A replay the ledger refused for a reason of its own (not «no record», not «red») — a legend defect candidate.
const REPLAY_REFUSED = /^(stale|output-|artifact-)/;
// The checks the ledger's preload sees in an AgentDeck copy (tools/verify-ledger/checks.cjs: vitest, tsc, eslint,
// prettier, vite build): a run of one of these with no ledger event from its copy bypassed the legend.
const LEGEND_CHECK = /\b(?:vitest|tsc|eslint|prettier|vite\s+build)\b|\b(?:pnpm|npm|yarn)\s+(?:(?:-C|--dir|--filter|-F)\s+\S+\s+)*(?:run\s+)?(?:test|lint|type-?check|typecheck|format:check|build)\b/;
// A check's ledger events land while it runs; judged this long after its end so a slow feed write is not a GAP.
const GAP_GRACE_MS = 20e3;

export function scanLedger(ctx, units) {
  const { o, s } = ctx;
  const P = s.plugin;
  const f = path.join(appDataOf(o), 'verify-ledger', 'events.jsonl');
  // misses M-13: a boot reinstalled the ledger every copy runs, and nobody looked at which version it took.
  let bin = '';
  try {
    bin = fs.readFileSync(path.join(appDataOf(o), 'verify-ledger', 'bin', 'current'), 'utf8').trim();
  } catch {
    /* ledger never installed */
  }
  if (bin && P.ledgerBin && bin !== P.ledgerBin) ctx.emit('—', 'mid', 'LEDGER', `legend reinstalled ${P.ledgerBin} → ${bin} — every copy runs it from its next check; confirm it is the version meant (HEAD while tools/verify-ledger is dirty)`);
  if (bin) P.ledgerBin = bin;
  let size = -1;
  try {
    size = fs.statSync(f).size;
  } catch {
    /* no ledger feed → COVER ✗ */
  }
  ctx.cover.legend = size >= 0;
  if (size < 0) return;
  P.ledger ??= {};
  const quiet = P.ledgerOff === undefined;
  if (quiet || size < P.ledgerOff) P.ledgerOff = 0;
  const fromStart = P.ledgerOff === 0;
  const chunk = readFrom(f, P.ledgerOff, 2 * 1024 * 1024);
  if (!chunk) return;
  P.ledgerOff += chunk.used;
  if (fromStart) P.ledgerSince = undefined;
  for (const l of chunk.text.split('\n')) {
    let e;
    try {
      e = JSON.parse(l);
    } catch {
      continue;
    }
    // The feed's earliest event: a check that ended before it ran before the legend existed — no GAP (judgeGaps).
    if (typeof e.at === 'number' && !(e.at >= P.ledgerSince)) P.ledgerSince = e.at;
    const hit = units.find(([, u]) => within(e.repo ?? e.cwd, u.copy));
    if (hit) ledgerEvent(ctx, hit[0], e, quiet);
    // #g8:88 (26.10): a review lane ran tsc in its scratch clone outside the copy; the ledger recorded it under the
    // clone — kept here so judgeGaps finds it for the check whose command names that clone.
    else if (typeof e.at === 'number' && (e.repo ?? e.cwd)) ring((P.ledgerElse ??= []), { repo: String(e.repo ?? e.cwd), at: e.at }, 200);
  }
}

/**
 * The check ran outside its copy and the legend saw it there: an event from a repo the command names landed in the
 * run's window. Named = the command holds the repo's last three path segments — the head of the path differs
 * between the shell's 8.3 form (`SHORT~1`) and the ledger's long one.
 */
function seenElsewhere(P, q) {
  const cmd = low(q.cmd ?? '');
  if (!cmd) return false;
  return (P.ledgerElse ?? []).some((e) => {
    if (!(e.at >= q.start - 3e3 && e.at <= q.end + 10e3)) return false;
    const tail = low(e.repo).split('/').filter(Boolean).slice(-3);
    return tail.length === 3 && cmd.includes(tail.join('/'));
  });
}

function ledgerEvent(ctx, name, e, quiet) {
  const L = (ctx.s.plugin.ledger[name] ??= { rec: 0, recMs: 0, hit: 0, savedMs: 0, delta: 0, miss: {}, off: {}, green: {}, lastMiss: {} });
  ring((L.at ??= []), e.at ?? Date.now());
  const call = (ctx.ledgerCall[name] ??= { rec: 0, hit: 0, warned: false });
  const say = (sev, text) => (quiet ? null : ctx.emit(name, sev, 'LEDGER', text));
  const k = `${e.check}|${e.key}`;
  if (e.kind === 'record') {
    L.rec += 1;
    L.recMs += e.ms ?? 0;
    // #g3:123 (25.10): a first run on a tree the legend never saw has nothing to replay — not a missed replay.
    L.seen ??= {};
    const fresh = L.lastMiss[k] === 'no-record' && !L.seen[k];
    L.seen[k] = e.at ?? Date.now();
    trim(L.seen);
    if (!quiet && !fresh) call.rec += 1;
    if (e.exit === 0 && L.green[k] && (L.lastMiss[k] ?? 'no-record') === 'no-record') {
      const ev = say('hi', `${e.check} re-ran on a tree the legend holds green (key ${e.key}) — replay missed`);
      if (ev) ev.waste = 'legend';
    }
    if (e.exit === 0) L.green[k] = e.at;
    trim(L.green);
  } else if (e.kind === 'hit') {
    L.hit += 1;
    L.savedMs += e.savedMs ?? 0;
    if (!quiet) call.hit += 1;
  } else if (e.kind === 'delta') L.delta += 1;
  else if (e.kind === 'miss') {
    L.miss[e.reason] = (L.miss[e.reason] ?? 0) + 1;
    L.lastMiss[k] = e.reason;
    trim(L.lastMiss);
    if (REPLAY_REFUSED.test(e.reason ?? '')) say('mid', `${e.check} replay refused: ${e.reason}`);
  } else if (e.kind === 'off') {
    const why = String(e.reason ?? '?');
    L.off[why] = (L.off[why] ?? 0) + 1;
    if (why === 'tree-changed') say('mid', `${e.check} not recorded: the tree changed while it ran`);
    else say('hi', `legend off for this copy: ${one(why, 140)} (${e.check})`);
  } else if (e.kind === 'mismatch') say('hi', `${e.check} replay would differ: recorded exit ${e.recordedExit}, real exit ${e.exit}`);
  else if ((e.kind === 'would-skip' || e.kind === 'shadow-ok') && !L.modeWarned) {
    L.modeWarned = true;
    say('hi', `legend in mode ${e.mode ?? e.kind} — replays disabled for this copy`);
  }
  if (!quiet && !call.warned && call.rec >= 3 && call.hit === 0) {
    call.warned = true;
    const ev = say('mid', `${call.rec} checks ran for real this call, 0 replays`);
    if (ev) ev.waste = 'legend';
  }
}

/**
 * Coverage: every check a group ran (core's checkRuns, from the transcript) must show in the ledger feed of its
 * copy while it ran. None = the run bypassed the legend (no preload in that CLI's env, a wrapper the registry
 * does not know) — it can never be replayed, so every rerun of it is paid in full.
 */
export function judgeGaps(ctx) {
  const P = ctx.s.plugin;
  P.gapQ ??= [];
  ctx.gapSeen ??= 0;
  for (const r of ctx.w.checkRuns.slice(ctx.gapSeen)) if (ctx.s.units[r.unit]?.group && LEGEND_CHECK.test(r.check ?? '')) P.gapQ.push({ unit: r.unit, check: r.check, cmd: one(r.cmd ?? '', 600), start: r.start, end: r.end, exit: r.exit });
  ctx.gapSeen = ctx.w.checkRuns.length;
  const now = Date.now();
  const keep = [];
  for (const q of P.gapQ) {
    if (now - q.end < GAP_GRACE_MS) {
      keep.push(q);
      continue;
    }
    // 25.10: g0's 23.10 checks raised 13 GAPs against a feed whose first event is 24.10 08:58.
    if (P.ledgerSince !== undefined && q.end < P.ledgerSince) continue;
    const ats = P.ledger?.[q.unit]?.at ?? [];
    if (ats.some((t) => t >= q.start - 3e3 && t <= q.end + 10e3)) continue;
    if (seenElsewhere(P, q)) continue;
    const ev = ctx.emit(q.unit, 'hi', 'GAP', `${one(q.check, 90)} ran ${age(q.end - q.start)} (exit ${q.exit}) with no verify-ledger event from this copy — outside the legend, never replayable: check NODE_OPTIONS preload in this CLI's env`);
    ev.waste = 'gap';
  }
  P.gapQ = keep.slice(-50);
}

export function ledgerPart(L) {
  if (!L) return 'legend: no events for this copy';
  const runs = L.rec + L.hit;
  const why = Object.entries({ ...L.miss, ...Object.fromEntries(Object.entries(L.off).map(([k, v]) => [`off:${k}`, v])) })
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([k, v]) => `${k}=${v}`)
    .join(' ');
  return `legend rec ${L.rec} (${age(L.recMs)}) hit ${L.hit} (${age(L.savedMs)} saved, ${runs ? Math.round((100 * L.hit) / runs) : 0}%) Δ ${L.delta}${why ? ` · ${why}` : ''}`;
}
