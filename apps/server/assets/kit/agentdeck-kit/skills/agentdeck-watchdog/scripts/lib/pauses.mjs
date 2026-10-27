// Pauses of watched groups. Three ways a group gets armed:
//   ordered  --pause-at-safe <parent>:<i>                    → paused at its next safe point
//   waste    any flag of the group carrying `waste` (REPEAT, RERUN, BIG, GAP, RUN heavy, WINDOW …) → safe point
//   burn     a flag carrying `burn` (BURN, STALL)              → paused NOW, mid-turn: the loop is the cost
// Pause kills the running turn and sweeps its processes, no git reset: files survive, the in-flight tool call is
// lost — so a safe point is preferred whenever waiting costs less than the loop. An arm is consumed by its pause;
// before that only `--disarm <parent>:<i> --row <id>` removes it, the row being a fixed ledger/inbox row.
// PAUSE-RACE: a pause the panel answered 2xx while the group kept writing or never reached paused.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { T, age, hms, nativePath, one } from '../../../watchdog/scripts/lib/core.mjs';
import { ledgerFiles } from '../../../watchdog/scripts/lib/keepalive.mjs';
import { control, parseGroup } from '../group-control.mjs';
import { panelBase, panelTokenFile } from './panel.mjs';
import { appDataOf, groupUnits, mtime } from './common.mjs';

export const PAUSABLE = new Set(['started', 'background', 'awaiting', 'pending']);
// `awaiting` for the human: the turn is over and nothing runs, so a pause stops nothing — and the panel's pause wipes
// the wait, its resume sends «continue» = a whole turn for nothing (g1 26.10 #g1:144: awaiting(mr-red) paused for RUN).
// The arm stays: the group's next turn (the human answered) is what it pauses.
export const HUMAN_WAITS = new Set(['question', 'decision', 'human-op', 'mr-red']);
const RACE_GRACE_MS = 20e3;
const RACE_WATCH_MS = 10 * 60e3;
// A pause this watch made is the coordinator's to lift: past this, UNRESUMED names the group still standing.
export const RESUME_DUE_MS = 15 * 60e3;
// A burn arm older than this whose own call already returned is not the loop running now: the call a pause NOW would
// cut is another one (g1 26.10 #g1:106→118: BURN 18:28:19, its call back 18:28:25, paused 18:33:05 mid `tests-cli
// delivery`, verdict lost). Inside it the loop is taken as live — a fast call returns before the next poll.
export const BURN_LIVE_MS = 30e3;
const GROUP_CONTROL = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'group-control.mjs').replace(/\\/g, '/');

/**
 * Is the conversation a flag came from still the stage that runs? A waste flag read from a conversation the group
 * already left, or from one idle past T.stallSec, has nothing left to stop: g5 25.10, BIG #g5:157 in the closed
 * verify 1dfd6a07 (idle 29 min) paused the group for 30 min. Null = cannot judge (no transcript behind the flag).
 */
export function staleFlag(w, name, f, sid) {
  const fst = f ? w.s.files?.[f] : null;
  // A flag on a finished run (RUN) names its session, not a file (26.10 #g9:134: the run handed off to a clean session).
  const from = fst?.sid ?? sid;
  if (!fst && !from) return null;
  const st = w.status(name);
  if (!st.active) return null;
  if (from && st.sid && from !== st.sid) return `its conversation ${String(from).slice(0, 8)} is no longer the active one (${String(st.sid).slice(0, 8)})`;
  if (!fst) return null;
  if (st.active.turnEnded && st.endedAt && Date.now() - st.endedAt >= T.stallSec * 1000) return `the active conversation is idle ${age(Date.now() - st.endedAt)}`;
  return null;
}

const unitOf = (s, spec) => {
  const g = parseGroup(spec);
  return g ? (groupUnits(s).find(([, u]) => u.group.index === g.index && (u.group.parent === g.parent || u.group.parent.startsWith(g.parent)))?.[0] ?? null) : null;
};

/** `--disarm`: null when done or not asked, else the refusal text. Runs before the watch, so a refusal costs nothing. */
export function disarm(ctx) {
  const { o, s } = ctx;
  const specs = o.disarm ?? [];
  if (!specs.length) return null;
  const rows = o.row ?? [];
  if (!rows.length) return 'refused: --disarm needs --row <id> — the fixed ledger/inbox row that removed the cause';
  // 26.10: `--disarm g8 --row A --disarm g9 --row B` took B for both — each --disarm owns the --row after it; one
  // --row for several groups still covers them all. Every pair is checked before any arm goes.
  if (rows.length > 1 && rows.length !== specs.length) return `refused: ${specs.length} --disarm but ${rows.length} --row — one --row for all, or one after each --disarm`;
  const dir = path.join(path.resolve(nativePath(o.repo ?? process.cwd())), '.agent', 'live-watch');
  const pairs = specs.map((spec, i) => ({ spec, id: rows[rows.length > 1 ? i : 0] }));
  for (const { id } of pairs) {
    const no = rowRefusal(dir, id);
    if (no) return no;
  }
  const P = s.plugin;
  for (const { spec, id } of pairs) {
    const name = unitOf(s, spec);
    if (!name) return `refused: --disarm ${spec} is not a watched group`;
    if (P.armed?.[name]) {
      delete P.armed[name];
      ctx.notes.push(`disarmed ${name} by row ${id}`);
    }
  }
  return null;
}

/** Null when the row exists once and its status cell is terminal, else the refusal text. */
function rowRefusal(dir, id) {
  // A row is found by its id cell, never by the token anywhere (25.10: numbered ledgers per group share
  // ids, «17» matched «row 17» of another group). `<file part>:<id>` names the ledger when ids repeat.
  const cut = id.lastIndexOf(':');
  const [hint, rowId] = cut > 0 ? [id.slice(0, cut), id.slice(cut + 1)] : ['', id];
  const hits = [];
  try {
    // Archived rows count: terminal rows leave an over-budget ledger for `.agent/archive/live-watch/`.
    for (const { f, path: file } of ledgerFiles(dir)) {
      if (hint && !f.includes(hint)) continue;
      for (const l of fs.readFileSync(file, 'utf8').split('\n')) {
        const cell = l.match(/^\|\s*([^|]+?)\s*\|/);
        const item = l.match(/^- ([\w-]+) · [^·\n]+ · ([^·\n]+) ·/);
        // Status: the last table cell, or the third field of an inbox line (`id · when · status · what`).
        if (cell?.[1] === rowId) hits.push({ f, l, status: l.replace(/\|\s*$/, '').split('|').at(-1).trim() });
        else if (item?.[1] === rowId) hits.push({ f, l, status: item[2].trim() });
      }
    }
  } catch {
    /* no ledger */
  }
  if (!hits.length) return `refused: no row ${id} in ${dir}`;
  if (hits.length > 1) return `refused: row ${rowId} is in ${[...new Set(hits.map((h) => h.f))].join(', ')} — name it as <file part>:${rowId}`;
  const [{ l: line, status }] = hits;
  // The status cell decides, not a word anywhere in the row. `expected` / `wontfix`: the flag was judged
  // no waste, so there is nothing a pause would stop (25.10: a sliced read for a merge conflict, BIG #g0:101).
  if (!/^(?:fixed|verified|applied|OWNER decision|expected|wontfix)\b/i.test(status)) return `refused: row ${id} is not fixed (or expected / wontfix / an OWNER decision) yet: ${one(line, 160)}`;
  return null;
}

export async function pauses(ctx) {
  const { o, s, w, emit } = ctx;
  const P = s.plugin;
  P.armed ??= {};
  P.paused ??= {};
  P.race ??= {};
  P.held ??= {};
  for (const spec of o['pause-at-safe'] ?? []) {
    const name = unitOf(s, spec);
    if (name && !P.armed[name] && !ctx.ordered?.has(name)) {
      P.armed[name] = { at: Date.now(), why: 'ordered (--pause-at-safe)', ref: '', now: false };
      (ctx.ordered ??= new Set()).add(name);
    }
  }
  // Arm from the flags of this call, each flag once.
  ctx.armSeen ??= 0;
  for (; ctx.armSeen < w.events.length; ctx.armSeen++) {
    const e = w.events[ctx.armSeen];
    if (!e.waste && !e.burn) continue;
    const targets = e.allGroups ? groupUnits(s).map(([n]) => n) : s.units[e.unit]?.group ? [e.unit] : [];
    for (const n of targets) {
      const stale = staleFlag(w, n, e.f, e.sid);
      if (stale) {
        ctx.notes?.push(`no arm for ${n} by ${e.tag} ${e.ref}: ${stale}`);
        continue;
      }
      // A flag folded into the panel's WSIG (lib/fold.mjs) arms as that WSIG: the row cites the line the digest shows.
      const tag = e.folded ? `WSIG ${e.folded.rule}` : e.tag;
      const ref = e.folded?.ref ?? e.ref;
      const a = (P.armed[n] ??= { at: e.at, why: `${tag}${e.waste ? ` ${e.waste}` : ''}`, ref, now: false, f: e.f, sid: e.sid });
      if (e.burn) Object.assign(a, { now: true, why: `${tag} ${e.waste ?? ''}`.trim(), ref, f: e.f, sid: e.sid, at: e.at, call: e.call });
    }
  }
  const fresh = P.stateMtime === mtime(path.join(appDataOf(o), 'state.json'));
  for (const [name, a] of Object.entries(P.armed)) {
    const u = s.units[name];
    if (!u?.group) {
      delete P.armed[name];
      continue;
    }
    const g = P.groups?.[name];
    // The status snapshot must be the one parsed from the CURRENT state.json, or the pause acts on old news.
    if (!g || !fresh) continue;
    if (!PAUSABLE.has(g.status)) {
      // Already paused / held / done: the arm has nothing to stop.
      if (['paused', 'held', 'done', 'failed'].includes(g.status)) delete P.armed[name];
      continue;
    }
    if (g.status === 'awaiting' && HUMAN_WAITS.has(g.waitingFor)) continue;
    // Paused once in this chat and stage already: a second pause is a loop — PAUSE-RACE names why it did not hold.
    // A resume (paused → running, seen in diff) clears the key, so the next waste arms it again.
    if (P.paused[name] === g.chatId + g.stages) continue;
    // An arm waits for a safe point; by then its flag's conversation may be over — a stage that ended is no waste.
    // The panel moved the group to a conversation not born yet (handoff, next stage): its old transcript still reads
    // SAFE, and a pause now cuts the new one before its first turn (26.10 #g9:133–135: paused 1.7 s into a handoff).
    // The arm waits for the birth; a flag of the closed conversation is dropped there by its session.
    if (!a.now && String(g.chatId ?? '').startsWith('new-')) continue;
    const stale = staleFlag(w, name, a.f, a.sid);
    if (stale) {
      ctx.notes?.push(`arm of ${name} (${a.why}${a.ref ? ` ${a.ref}` : ''}) dropped: ${stale}`);
      delete P.armed[name];
      continue;
    }
    const st = w.status(name);
    // Seen late (a blind window, a status that was not pausable): the flagged call returned, so what runs now is
    // another call — the burn waits for the safe point instead of cutting it. A burn with no call (STALL) stays NOW.
    if (a.now && a.call && Date.now() - (a.at ?? 0) > BURN_LIVE_MS && !w.s.files?.[a.f]?.open?.[a.call]) {
      a.now = false;
      emit(name, 'mid', 'PAUSE-STALE', `${a.why}${a.ref ? ` ${a.ref}` : ''} flagged ${age(Date.now() - a.at)} ago and its call already returned — a pause NOW would cut ${st.open.length ? one(st.open.map((x) => `${x.name} ${x.b ?? ''}`).join(', '), 120) : 'the next call'}; armed for the safe point instead`);
    }
    if (!a.now && st.safe !== true) continue;
    const r = await control({ action: 'pause', parent: u.group.parent, index: u.group.index, base: panelBase(o), tokenFile: panelTokenFile(o) });
    const ok = r.code >= 200 && r.code < 300;
    const due = Date.now() + RESUME_DUE_MS;
    const resume = `node ${GROUP_CONTROL} resume --group ${u.group.parent}:${u.group.index}`;
    emit(name, 'hi', ok ? 'PAUSED' : 'PAUSE!', `${a.now ? 'NOW, mid-turn' : `at safe point (turn ended, nothing open, status ${g.status})`} for ${a.why}${a.ref ? ` ${a.ref}` : ''}: HTTP ${r.code} ${one(r.body, 140)}${ok ? ` · resume: coordinator, once the row is fixed, due ${hms(due).slice(0, 5)} — ${resume}` : ''}`);
    if (ok) {
      delete P.armed[name];
      P.paused[name] = g.chatId + g.stages;
      P.race[name] = { at: Date.now(), last: st.last ?? 0 };
      P.held[name] = { at: Date.now(), why: a.why, ref: a.ref, by: 'coordinator', due, cmd: resume };
    }
  }
  // A pause this watch made is lifted by the coordinator; one still standing past its due time is named once
  // (g5 25.10: paused 30 min with nobody owning the resume). The owner's hold.json is a stop on purpose: no nag.
  const holdFile = path.join(path.resolve(nativePath(o.repo ?? process.cwd())), '.agent', 'live-watch', 'hold.json');
  for (const [name, h] of Object.entries(P.held)) {
    const g = P.groups?.[name];
    const stopped = !!g && ['paused', 'held'].includes(g.status);
    if (stopped) h.seen = true;
    // Gone: resumed (seen paused, now running), or never reached paused (PAUSE-RACE already named that).
    if (!s.units[name]?.group || (h.seen && g && fresh && !stopped) || (!h.seen && Date.now() - h.at > RACE_WATCH_MS)) {
      delete P.held[name];
      continue;
    }
    // The watch itself was blind while this pause stood: rows written between calls, or calls refused for owed rows.
    // Counted from the pause when it is younger than the last pass (g1 26.10 #g1:146: paused in this very pass after
    // a 52-min gap, and WATCH-DARK blamed the gap on the pause).
    const darkFrom = darkSince(ctx.s.lastWake, h.at);
    const dark = darkFrom ? Date.now() - darkFrom : 0;
    if (!ctx.darkSeen?.has(name) && stopped && dark > RESUME_DUE_MS && !fs.existsSync(holdFile)) {
      (ctx.darkSeen ??= new Set()).add(name);
      emit(name, 'hi', 'WATCH-DARK', `no watch pass ${hms(darkFrom).slice(0, 5)}→${hms(Date.now()).slice(0, 5)} (${age(dark)}) while it stood paused by the watch for ${h.why}${h.ref ? ` ${h.ref}` : ''} — write owed rows in one batch, resume before fixing what the row judges no fault`);
    }
    if (h.nagged || Date.now() < h.due || !stopped || fs.existsSync(holdFile)) continue;
    h.nagged = true;
    emit(name, 'hi', 'UNRESUMED', `paused ${age(Date.now() - h.at)} ago for ${h.why}${h.ref ? ` ${h.ref}` : ''}, due back ${hms(h.due).slice(0, 5)} and still ${g.status} — fix the row and resume: ${h.cmd}`);
  }
  // A 2xx pause is a request, not a fact: the group must stop writing and reach paused.
  const now = Date.now();
  for (const [name, x] of Object.entries(P.race)) {
    if (now - x.at > RACE_WATCH_MS) {
      delete P.race[name];
      continue;
    }
    const g = P.groups?.[name];
    const stopped = !!g && ['paused', 'held'].includes(g.status);
    // Seen stopped even inside the grace: the pause held. Running again after that is a resume, not a race
    // (26.10 #g9:116: paused 01:26, seen paused 01:26:14, resumed 01:30, next look 01:35 cried PAUSE-RACE).
    if (stopped) x.seen = true;
    if (now - x.at < RACE_GRACE_MS) continue;
    if (x.seen && !stopped) {
      delete P.race[name];
      continue;
    }
    const last = w.status(name).last ?? 0;
    const writing = last > x.at + RACE_GRACE_MS;
    if (writing || (g && PAUSABLE.has(g.status))) {
      emit(name, 'hi', 'PAUSE-RACE', `paused ${age(now - x.at)} ago, yet ${writing ? `its transcript grew ${age(last - x.at)} after the pause` : `the panel still shows ${g.status}`} — the pause did not hold: read the panel's pause path before pausing again`);
      delete P.race[name];
    } else if (g && ['paused', 'held'].includes(g.status)) delete P.race[name];
  }
}

/** Start of the blind stretch over a watch pause: the last pass, or the pause itself if it came later. */
export function darkSince(lastWake, pausedAt) {
  return Math.max(lastWake ?? 0, pausedAt ?? 0);
}

/**
 * The owed-rows refusal runs no pass, so the pass's UNRESUMED / WATCH-DARK cannot fire there (g1 26.10 #g1:118: due
 * 18:48, refused 18:44 and 19:46, resumed 19:46). Status only, nothing saved: the next pass still diffs every move.
 * `statusOf(unit)` = the group's status in the current state.json, or null.
 */
export function standing(ctx, statusOf) {
  const { o, s } = ctx;
  const holdFile = path.join(path.resolve(nativePath(o.repo ?? process.cwd())), '.agent', 'live-watch', 'hold.json');
  if (fs.existsSync(holdFile)) return [];
  const now = Date.now();
  const out = [];
  for (const [name, h] of Object.entries(s.plugin?.held ?? {})) {
    const u = s.units[name];
    if (!u?.group) continue;
    const status = statusOf(u);
    if (!['paused', 'held'].includes(status)) continue;
    const from = darkSince(s.lastWake, h.at);
    const dark = from ? now - from : 0;
    const why = `${h.why}${h.ref ? ` ${h.ref}` : ''}`;
    if (now >= h.due) out.push(`UNRESUMED ${name}: paused ${age(now - h.at)} ago for ${why}, due back ${hms(h.due).slice(0, 5)} and still ${status} — resume now if the row judges the flag no fault, else fix and resume: ${h.cmd}`);
    if (dark > RESUME_DUE_MS) out.push(`WATCH-DARK ${name}: no watch pass for ${age(dark)} while it stands paused by the watch`);
  }
  return out;
}

export function armedPart(P, name) {
  const a = P.armed?.[name];
  return a ? `ARMED ${a.now ? 'pause NOW' : 'pause at safe point'} (${a.why}${a.ref ? ` ${a.ref}` : ''})` : '';
}
