#!/usr/bin/env node
// AgentDeck split groups over the universal watch: each --group becomes a unit on its copy's transcript dir
// (path from state.json — copy dir names are shortened, never derive them from the branch) plus group events
// diffed from state.json, watcher signals with their rule text, the legend (verify-ledger), dev-server restarts,
// the limit window, and the pauses those findings arm.
//   node watch-groups.mjs --state <dir> --group <parent>:<i> [--group …] [--pause-at-safe <parent>:<i>]
//        [--disarm <parent>:<i> --row <fixed row id>] [--app-data <dir>] [--repo <agentdeck repo>] [--base url]
//        [--token-file f]   + every watch.mjs flag
// Every waste flag of a group arms its pause at the next safe point; BURN / STALL pause it now (lib/pauses.mjs).
// Each STAGE / ENDED names the audit to spawn over show.mjs --pack.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runWatch } from '../../watchdog/scripts/lib/run.mjs';
import { T, age, kc, nativePath, one } from '../../watchdog/scripts/lib/core.mjs';
import { MAPPED } from '../../watchdog/scripts/lib/foreign.mjs';
import { parseGroup } from './group-control.mjs';
import { appDataOf, groupUnits, mtime, reviewBudget } from './lib/common.mjs';
import { judgeGaps, ledgerPart, scanLedger } from './lib/legend.mjs';
import { PAUSABLE, armedPart, disarm, pauses, standing } from './lib/pauses.mjs';
import { scanRestarts } from './lib/restarts.mjs';
import { scanWindow, windowCover, windowPart } from './lib/window.mjs';
import { deferredCover, scanDeferred } from './lib/deferred.mjs';
import { discoverAppData } from './lib/panel.mjs';
import { foldPanel } from './lib/fold.mjs';
import { RULE_TEXTS_JSON, RULE_TEXTS_SRC, parseRuleTexts } from './lib/rule-texts.mjs';

const HUMAN_WAIT = new Set(['question', 'decision', 'human-op', 'limit', 'interrupted', 'review-missing']);
const ENDED = new Set(['done', 'failed']);
// A conversation born this close to a stage switch is that stage's conversation.
const STAGE_CONV_MS = 10 * 60e3;
// First prompt of a stage conversation → its mark; checked in this order.
const STAGE_BRIEFS = [
  // The MR recheck opens its own conversation (server split-recheck brief); first, because that brief also names
  // the MR and would read as a review. W1 (g5 27.10): the recheck had no mark, its pack began at `setup`, 1m45s in.
  [/the panel starts every MR\s+recheck fresh|asks the group to recheck its delivered MR/i, 'stage:recheck'],
  [/Your stage is VERIFYING/, 'stage:verify'],
  [/Your stage is delivering/i, 'stage:deliver'],
  [/reviewed the work[\s\S]{0,200}?— here are its findings/i, 'stage:fix'],
  [/This is a new session: the work was done/i, 'stage:review'],
  [/review the merge request/i, 'stage:mr-review'],
];
const SHOW = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'watchdog', 'scripts', 'show.mjs').replace(/\\/g, '/');
// Flags a follow-up call must repeat: what the state does not persist.
const CARRY = ['app-data', 'repo', 'base', 'token-file', 'config-root', 'ledger-dir'];
/** Open groups of the watched splits that no unit watches right now. */
const unwatched = (s) => {
  const w = new Set(groupUnits(s).map(([, u]) => `${u.group.parent}:${u.group.index}`));
  return (s.plugin?.siblings ?? []).filter((x) => !w.has(x.key));
};

function readState(o) {
  return JSON.parse(fs.readFileSync(path.join(appDataOf(o), 'state.json'), 'utf8'));
}
function findGroup(s, parent, index) {
  const plans = s.splitPlans ?? {};
  const key = plans[parent] ? parent : Object.keys(plans).find((k) => parent.length >= 8 && k.startsWith(parent));
  return key ? { key, group: plans[key].groups?.find((g) => g.index === index) ?? null } : { key: null, group: null };
}
// Rule texts of the panel's group watcher (R1…), read once: the repo's i18n module when the watch runs inside the
// panel's repo (--repo or the cwd), else the snapshot shipped beside these scripts (rule-texts.json, `node
// rule-texts.mjs --write` refreshes it) — a watch started from any other project used to show raw rule ids.
function ruleTexts(o) {
  const out = parseRuleTexts(readOr(path.join(path.resolve(nativePath(o.repo ?? process.cwd())), RULE_TEXTS_SRC)));
  if (Object.keys(out).length) return out;
  try {
    return JSON.parse(fs.readFileSync(RULE_TEXTS_JSON, 'utf8')).texts ?? {};
  } catch {
    return {};
  }
}
const readOr = (f) => {
  try {
    return fs.readFileSync(f, 'utf8');
  } catch {
    return '';
  }
};
/** First user prompt of a transcript and its time, from its head — the brief that opened the conversation. */
function firstPrompt(f) {
  let head;
  try {
    const fd = fs.openSync(f, 'r');
    const b = Buffer.alloc(Math.min(fs.fstatSync(fd).size, 512 * 1024));
    fs.readSync(fd, b, 0, b.length, 0);
    fs.closeSync(fd);
    head = b.toString('utf8');
  } catch {
    return null;
  }
  for (const l of head.split('\n')) {
    let r;
    try {
      r = JSON.parse(l);
    } catch {
      continue;
    }
    if (r?.type !== 'user' || r.isMeta || r.isCompactSummary || r.isVisibleInTranscriptOnly) continue;
    const c = r.message?.content;
    const text = (typeof c === 'string' ? c : Array.isArray(c) ? c.filter((p) => p?.type === 'text').map((p) => p.text).join('\n') : '').trim();
    if (!text || /^<(?:local-command|command-name|command-message|command-args|bash-)/.test(text) || /<task-notification>/.test(text)) continue;
    return { text, at: Date.parse(r.timestamp ?? '') };
  }
  return null;
}
const fill = (tpl, sig) => tpl.replace(/\{\{(\w+)\}\}/g, (_, k) => String(sig.numbers?.[k] ?? sig.params?.[k] ?? `{${k}}`));
function snap(g, sigs, prev) {
  const chats = [...new Set([...(prev?.chats ?? []), g.chatId].filter(Boolean))].slice(-20);
  return {
    status: g.status, waitingFor: g.waitingFor ?? null, chatId: g.chatId ?? null, chats, nudges: g.deliveryNudges ?? 0,
    missing: (g.deliveryMissing ?? []).map(String), rounds: g.deliveryHistory?.length ?? 0, mr: g.mr ?? null,
    stages: g.stageTrace?.length ?? 0, stage: g.stageTrace?.at(-1)?.stage ?? null, sigIds: sigs.map((x) => x.id),
  };
}
const hasMark = (s, name, mark) => (s.marks?.[name] ?? []).some((m) => m.name === mark);
/** The mark a closing stretch starts at: `stageName`, or the latest recheck conversation when that began later. */
function lastStretch(list, stageName) {
  const at = (pred) => list.reduce((t, m) => (pred(m) && m.at > t ? m.at : t), -Infinity);
  const stageAt = at((m) => m.name === stageName);
  let best = null;
  for (const m of list) if (/^stage:recheck(?:#\d+)?$/.test(m.name) && m.at > stageAt && (!best || m.at >= best.at)) best = m;
  return best ? best.name : stageName;
}
// The audit a finished stage gets: one lane-high reviewer over the stage's own records.
function auditLine(ctx, name, stage, from, to) {
  const f = hasMark(ctx.s, name, from) ? from : 'setup';
  const budget = reviewBudget();
  // The stage's flags ride along by record time (`--list`): a replay stamps every flag at its wake (g9 26.10, F1).
  const on = `--state ${ctx.stateDir.replace(/\\/g, '/')}`;
  return `audit: spawn «review: watch audit ${name} ${stage}» (lane-high) on node ${SHOW} ${on} --pack ${name} --from ${f} --to ${to}, flags: --list ${name} --from ${f} --to ${to} --last 400${budget ? ` (${budget})` : ''}`;
}
// A conveyor that stopped: the group's turn ended past --stall, nothing is open, and the panel neither closed it nor
// waits on a person or the limit — nobody starts the next turn, and STALL cannot see it (it needs a running turn).
// Once per ended turn.
const IDLE_SKIP = new Set(['paused', 'held', 'pending', 'waiting', ...ENDED]);
const CUT = new Set(['paused', 'held', ...ENDED]);
function idle(ctx, units) {
  const P = ctx.s.plugin;
  const now = Date.now();
  P.idle ??= {};
  for (const [name] of units) {
    const g = P.groups?.[name];
    if (!g || IDLE_SKIP.has(g.status) || HUMAN_WAIT.has(g.waitingFor)) continue;
    const st = ctx.w.status(name);
    if (!st.safe || !st.endedAt || now - st.endedAt < T.stallSec * 1000 || P.idle[name] === st.endedAt) continue;
    P.idle[name] = st.endedAt;
    ctx.emit(name, 'hi', 'IDLE', `turn ended ${age(now - st.endedAt)} ago, nothing open, the panel still shows ${g.status}${g.waitingFor ? `(${g.waitingFor})` : ''} — no next turn started: why is the conveyor not moving?`);
  }
}

const plugin = {
  valueFlags: ['app-data', 'repo', 'base', 'token-file'],
  multiFlags: ['group', 'pause-at-safe', 'disarm', 'row'],
  usage: '  --group <parent>:<i> (repeatable) · --pause-at-safe <parent>:<i> · --disarm <parent>:<i> --row <id> (pairs repeatable) · --app-data · --repo · --base · --token-file',
  // The panel's data dir when no flag names it: asked from the panel itself (lib/panel.mjs). Kept off `--app-data`
  // so the next-call command re-asks instead of pinning a guess.
  async prepare(o) {
    if (o['app-data']) return;
    const d = await discoverAppData(o);
    o._appData = d.dir;
    o._appDataFrom = d.from;
  },
  units(ctx) {
    const { o, s } = ctx;
    s.plugin ??= {};
    s.plugin.groups ??= {};
    ctx.notes = [];
    if (o.group?.length) {
      let st;
      try {
        st = readState(o);
      } catch (e) {
        return `cannot read ${appDataOf(o)}/state.json: ${e.message}`;
      }
      const specs = o.group.map((x) => ({ x, g: parseGroup(x) }));
      const bad = specs.find((y) => !y.g);
      if (bad) return `bad --group "${bad.x}" — expected <parentChatId>:<index>`;
      const parents = new Set(specs.map((y) => y.g.parent));
      for (const { g } of specs) {
        const { key, group } = findGroup(st, g.parent, g.index);
        if (!group) return `no group ${g.index} under split ${g.parent} in state.json`;
        const name = parents.size > 1 ? `g${g.index}-${key.replace(/[^A-Za-z0-9]/g, '').slice(0, 6)}` : `g${g.index}`;
        const provider = key.includes(':') ? key.slice(0, key.indexOf(':')) : 'claude';
        const extra = { copy: group.path, group: { parent: key, index: g.index, provider } };
        // Another CLI's group: its transcripts mapped by foreign.mjs; unmapped = status + signals only.
        if (provider === 'claude') ctx.addUnit(name, 'cwd', group.path, extra);
        else ctx.addUnit(name, 'foreign', `${provider}:${key}:${g.index}`, extra);
        const sigs = st.groupWatchSignals?.[key]?.[String(g.index)]?.signals ?? [];
        s.plugin.groups[name] ??= snap(group, sigs);
      }
    }
    return disarm(ctx);
  },
  // W4: a conversation born mid-watch is named by the stage brief that opens it (panel texts, templates.ts); a
  // handoff into the same stage (continuation after a pause/limit) names nothing — core falls back to conv:<sid8>.
  convName(text) {
    const t = String(text ?? '');
    if (/The panel started a new conversation instead of continuing|new session of a split group: the previous conversation is closed|This is a new session: the previous conversation is closed/i.test(t)) return null;
    for (const [re, n] of STAGE_BRIEFS) if (re.test(t)) return n;
    return null;
  },
  // W1 (g5 27.10): a unit added while its recheck conversation already runs is seeded at the tail, so core never
  // sees that conversation born and never names it. Its newest main transcript is read from the head: opened by
  // the recheck brief → `stage:recheck` at its first record, that file wholly after it (offset 0).
  recheckSeeded(ctx) {
    const { s, w, added } = ctx;
    for (const name of added) {
      if (!s.units[name]?.group) continue;
      let newest = null;
      for (const [f, st] of Object.entries(s.files)) {
        if (st.unit !== name || st.role !== 'main' || !st.sid) continue;
        const t = mtime(f);
        if (!newest || t > newest.t) newest = { f, st, t };
      }
      if (!newest || (s.marks?.[name] ?? []).some((m) => m.conv === newest.st.sid)) continue;
      const p = firstPrompt(newest.f);
      if (!p || !Number.isFinite(p.at) || this.convName(p.text) !== 'stage:recheck') continue;
      w.mark(name, 'stage:recheck', { at: p.at, born: [newest.f], conv: newest.st.sid });
    }
  },
  // The panel stopped this group's process (paused, held, finished): its cut turn is not «running».
  stopped(name, ctx) {
    const st = ctx.s.plugin?.groups?.[name]?.status;
    return CUT.has(st) ? st : null;
  },
  scan(ctx) {
    const { o, s, w } = ctx;
    const P = s.plugin;
    const now = Date.now();
    const units = groupUnits(s);
    if (!ctx.rechecked) {
      ctx.rechecked = true;
      this.recheckSeeded(ctx);
    }
    ctx.cover ??= {};
    ctx.ledgerCall ??= {};
    // Tokens per stage: this call's spend added to the running stage total, reported and reset at STAGE.
    P.stageTok ??= {};
    ctx.spentSeen ??= {};
    for (const [name] of units) {
      const sp = w.spent[name];
      const tot = sp ? sp.out + sp.write + sp.read : 0;
      P.stageTok[name] = (P.stageTok[name] ?? 0) + tot - (ctx.spentSeen[name] ?? 0);
      ctx.spentSeen[name] = tot;
    }
    if (units.length) {
      const f = path.join(appDataOf(o), 'state.json');
      const t = mtime(f);
      if (t && t !== P.stateMtime && now - (ctx.lastParse ?? 0) >= 4000) {
        ctx.lastParse = now;
        let st = null;
        try {
          st = JSON.parse(fs.readFileSync(f, 'utf8'));
          P.stateMtime = t;
        } catch {
          /* mid-write: next pass */
        }
        if (st) {
          ctx.rules ??= ruleTexts(o);
          for (const [name, u] of units) this.diff(ctx, name, u, st);
          this.siblings(ctx, units, st);
        }
      }
    }
    idle(ctx, units);
    scanRestarts(ctx, units);
    scanLedger(ctx, units);
    scanWindow(ctx, units);
    scanDeferred(ctx, units);
    judgeGaps(ctx);
  },
  // Every source the watch depends on, read or not: a blind area is ✗ and raises COVER once per change.
  cover(ctx) {
    const { o, s, w, emit } = ctx;
    const P = s.plugin;
    const units = groupUnits(s);
    if (!units.length) return '';
    const c = ctx.cover ?? {};
    const texts = Object.keys(ctx.rules ?? ruleTexts(o)).length;
    const read = units.filter(([, u]) => u.group.provider === 'claude' || MAPPED.has(u.group.provider));
    const seen = read.filter(([n]) => w.status(n).safe !== null).length;
    const spent = read.filter(([n]) => w.status(n).spent).length;
    const copies = units.filter(([n]) => P.ledger?.[n]).length;
    const parts = [
      `state ${P.stateMtime ? `✓ changed ${age(Date.now() - P.stateMtime)} ago` : '✗ unread'}`,
      `rule texts ${texts ? `✓ ${texts}` : '✗ 0'}`,
      `legend ${c.legend ? `✓ ${copies}/${units.length} copies` : '✗ no verify-ledger/events.jsonl'}`,
      `restarts ${c.devlog ? `✓ ${(P.restartAt ?? []).length}/h` : '✗ no dev-watch.log'}`,
      `window ${windowCover(P.win, c.window)}`,
      `D-n ${deferredCover(P, c.deferred)}`,
      `transcripts ${seen}/${read.length}${read.length < units.length ? ` (+${units.length - read.length} status-only)` : ''}`,
      `spend ${spent}/${read.length}`,
    ];
    const bad = parts.filter((x) => x.includes('✗')).join(' · ');
    if (bad && bad !== P.coverBad) emit('—', 'hi', 'COVER', `blind: ${bad}`);
    P.coverBad = bad;
    return `COVER ${parts.join(' · ')}${ctx.notes?.length ? ` · ${ctx.notes.join(' · ')}` : ''}`;
  },
  diff(ctx, name, u, st) {
    const { emit, s, w } = ctx;
    const P = s.plugin;
    const { group } = findGroup(st, u.group.parent, u.group.index);
    if (!group) return;
    const sigs = st.groupWatchSignals?.[u.group.parent]?.[String(u.group.index)]?.signals ?? [];
    const prev = P.groups[name];
    const cur = snap(group, sigs, prev);
    P.groups[name] = cur;
    if (group.path && group.path !== u.copy) u.copy = group.path;
    if (!prev) return;
    const wf = (x) => `${x.status}${x.waitingFor ? `(${x.waitingFor})` : ''}`;
    if (wf(prev) !== wf(cur)) {
      const ended = ENDED.has(cur.status);
      const hi = ended || ['paused', 'held', 'failed'].includes(cur.status) || HUMAN_WAIT.has(cur.waitingFor);
      // The ended stretch starts at the later of the last panel stage and the last recheck conversation: a recheck
      // keeps the panel's stage (deliver), and its audit must not reach back into the delivery a day before (W1).
      const from = ended ? lastStretch(s.marks?.[name] ?? [], P.stageMark?.[name] ?? `stage:${cur.stage}`) : null;
      emit(name, hi ? 'hi' : 'mid', ended ? 'ENDED' : 'STATUS', `${wf(prev)} → ${wf(cur)}${ended ? ` · mr ${cur.mr ?? '-'} · ${auditLine(ctx, name, from.startsWith('stage:recheck') ? 'recheck' : (cur.stage ?? 'last'), from, 'ended')}; whole run: --from setup --to ended` : ''}`);
      if (ended) w.mark(name, 'ended');
      // A resume: the pause of this chat and stage is spent, the next waste may pause it again.
      if (['paused', 'held'].includes(prev.status) && PAUSABLE.has(cur.status)) delete P.paused?.[name];
    }
    if (cur.stages > prev.stages) {
      const tr = group.stageTrace ?? [];
      // W3 (g5 25.10): the mark is the stage's own start, not the wake that saw it (6m17s late), and «took» is
      // the distance between two such marks — the panel trace spans pauses and sleeps of the whole chat (64.2h).
      const evAt = Date.parse(tr.at(-1)?.at ?? '');
      const list = ((s.marks ??= {})[name] ??= []);
      const last = (n) => [...list].reverse().find((m) => m.name === n);
      // The panel names stages coarser than the conversations (fix → review again = verify, g5 25.10): the stretch's
      // own mark is the one recorded at the previous STAGE (P.stageMark), never «the last mark called stage:X» —
      // that would be this very switch, an empty audit.
      P.stageMark ??= {};
      const fromName = P.stageMark[name] ?? `stage:${prev.stage}`;
      const prevMark = last(fromName);
      const setup = last('setup');
      // A panel name already used gets a #n: an earlier audit line keeps pointing at its own stretch.
      const uniqName = (n) => (list.some((m) => m.name === n) ? `${n}#${list.filter((m) => m.name === n || m.name.startsWith(`${n}#`)).length + 1}` : n);
      // The new conversation of this stage may already carry its mark (core convMark, stamped at its first record).
      const conv = Number.isFinite(evAt) ? [...list].reverse().find((m) => m.conv && !m.stageOf && Math.abs(m.at - evAt) <= STAGE_CONV_MS && (!prevMark || m.at > prevMark.at)) : null;
      let mk;
      if (conv) {
        conv.stageOf = cur.stage;
        mk = conv;
        if (conv.name !== `stage:${cur.stage}`) {
          mk = { ...conv, name: uniqName(`stage:${cur.stage}`), aliasOf: conv.name };
          delete mk.conv;
          list.push(mk);
        }
      } else mk = w.mark(name, uniqName(`stage:${cur.stage}`), Number.isFinite(evAt) ? { at: Math.min(evAt, Date.now()) } : {});
      const toName = mk.aliasOf ?? mk.name;
      P.stageMark[name] = toName;
      const took = prevMark ? age(mk.at - prevMark.at) : `${setup ? `≥${age(mk.at - setup.at)}` : '?'} (began before the watch)`;
      const tok = P.stageTok?.[name] ?? 0;
      emit(name, 'hi', 'STAGE', `${prev.stage ?? '?'} → ${cur.stage} · ${prev.stage ?? 'the stage'} took ${took}, ${kc(tok)} tok watched · ${auditLine(ctx, name, prev.stage ?? 'start', fromName, toName)}`);
      if (P.stageTok) P.stageTok[name] = 0;
    }
    // A delivery nudge or round past the first is rework: the group is told again what it already owed.
    if (cur.nudges > prev.nudges) {
      const ev = emit(name, cur.nudges >= 2 ? 'hi' : 'mid', 'NUDGE', `delivery nudge #${cur.nudges} (stage ${cur.stage ?? '?'})${cur.nudges >= 2 ? ' — rework: why did the first nudge not land?' : ''}`);
      if (cur.nudges >= 2) ev.waste = 'nudge';
    }
    if (cur.rounds > prev.rounds) {
      const ev = emit(name, cur.rounds >= 2 ? 'hi' : 'mid', 'ROUND', `delivery round ${cur.rounds}: ${cur.missing.length} item(s) missing`);
      if (cur.rounds >= 2) ev.waste = 'round';
    }
    const fresh = cur.missing.filter((m) => !prev.missing.includes(m));
    for (const m of fresh.slice(0, 3)) emit(name, 'mid', 'MISSING', one(m, 200));
    if (fresh.length > 3) emit(name, 'mid', 'MISSING', `+${fresh.length - 3} more new missing items`);
    if (cur.mr !== prev.mr) emit(name, 'hi', 'MR', `${prev.mr ?? '-'} → ${cur.mr ?? '-'}`);
    if (cur.chatId !== prev.chatId) emit(name, 'mid', 'CONV', `group chat ${String(prev.chatId ?? '-').slice(0, 8)} → ${String(cur.chatId ?? '-').slice(0, 8)}`);
    for (const sig of sigs.filter((x) => !prev.sigIds.includes(x.id))) {
      // A rule's variant (R38done, R16slow) carries its own text: the rule id alone named the wrong one.
      const variant = String(sig.textKey ?? '').split('.').at(-1);
      const tpl = ctx.rules?.[variant] ?? ctx.rules?.[sig.rule];
      const nums = Object.entries({ ...sig.numbers, ...sig.params }).map(([k, v]) => `${k}=${v}`).join(' ');
      const ev = emit(name, sig.severity === 'info' ? 'mid' : 'hi', 'WSIG', `${sig.rule} ${sig.severity} ${sig.stage ?? ''}: ${tpl ? fill(tpl, sig) : nums}`);
      ev.rule = sig.rule;
    }
  },
  // The rest of every watched split, recomputed only when state.json moves; read through unwatched(), because a group
  // the very next call adds is watched before state.json changes again.
  // A group not watched and not closed keeps the watch (and the turn) alive, and one
  // that has its copy joins the next call — the next group is taken in the same turn, not when the owner asks (M-02).
  siblings(ctx, units, st) {
    const P = ctx.s.plugin;
    const watched = new Set(units.map(([, u]) => `${u.group.parent}:${u.group.index}`));
    const open = [];
    for (const parent of new Set(units.map(([, u]) => u.group.parent)))
      for (const g of st.splitPlans?.[parent]?.groups ?? [])
        if (!ENDED.has(g.status) && !watched.has(`${parent}:${g.index}`)) open.push({ key: `${parent}:${g.index}`, status: g.status, ready: !!g.path });
    P.siblings = open;
    P.nextSeen ??= {};
    for (const x of open.filter((y) => y.ready && !P.nextSeen[y.key])) {
      P.nextSeen[x.key] = true;
      ctx.emit('—', 'hi', 'NEXT', `group ${x.key} is ${x.status} and not watched yet — the next call adds it (--group ${x.key})`);
    }
  },
  // Owed-rows refusal: no pass runs, yet a pause of this watch past due or a blind watch is named (lib/pauses.mjs).
  refused(ctx) {
    let st = null;
    try {
      st = readState(ctx.o);
    } catch {
      return [`cannot read ${appDataOf(ctx.o)}/state.json — groups paused by the watch are not checked`];
    }
    return standing(ctx, (u) => findGroup(st, u.group.parent, u.group.index).group?.status ?? null);
  },
  async after(ctx) {
    foldPanel(ctx);
    await pauses(ctx);
    const units = groupUnits(ctx.s);
    const rest = unwatched(ctx.s).map((x) => x.key);
    const live = [...units.filter(([n]) => !ENDED.has(ctx.s.plugin.groups?.[n]?.status)).map(([n]) => n), ...rest];
    ctx.done = { all: units.length > 0 && !live.length, live, why: live.length ? '' : 'every group done/failed' };
  },
  // The next call: same state, plus the flags the state does not keep, plus every split sibling that has its copy.
  cmd(ctx) {
    const extra = CARRY.filter((k) => ctx.o[k]).map((k) => ` --${k} ${String(ctx.o[k]).replace(/\\/g, '/')}`).join('');
    const next = unwatched(ctx.s).filter((x) => x.ready).map((x) => ` --group ${x.key}`).join('');
    return `node ${fileURLToPath(import.meta.url).replace(/\\/g, '/')} --state ${ctx.stateDir.replace(/\\/g, '/')}${extra}${next}`;
  },
  footer(ctx, name, st) {
    const u = ctx.s.units[name];
    if (!u?.group) return '';
    const P = ctx.s.plugin;
    const g = P.groups?.[name];
    const parts = [];
    if (u.group.provider !== 'claude') parts.push(MAPPED.has(u.group.provider) ? `FOREIGN ${u.group.provider} — transcript mapped` : `FOREIGN ${u.group.provider} — status + signals only (no transcript parser)`);
    if (g) parts.push(`${g.status}${g.waitingFor ? `(${g.waitingFor})` : ''} · stage ${g.stage ?? '?'} · nudges ${g.nudges} · missing ${g.missing.length}${g.mr ? ` · mr ${g.mr.replace(/^.*merge_requests\//, '!')}` : ''}`);
    if (u.copy && fs.existsSync(u.copy)) {
      const r = spawnSync('git', ['-C', u.copy, '--no-optional-locks', 'status', '--porcelain'], { encoding: 'utf8', timeout: 8000 });
      if (r.status === 0) {
        const n = r.stdout.split('\n').filter(Boolean).length;
        parts.push(n ? `dirty ${n}` : 'clean');
      }
    }
    if (st.safe && g && !PAUSABLE.has(g.status)) parts.push(`not pausable in ${g.status}`);
    const armed = armedPart(P, name);
    if (armed) parts.push(armed);
    const win = windowPart(P.win, name);
    if (win) parts.push(win);
    parts.push(ledgerPart(P.ledger?.[name]));
    return parts.join(' · ');
  },
};

process.exitCode = await runWatch(process.argv.slice(2), plugin);
