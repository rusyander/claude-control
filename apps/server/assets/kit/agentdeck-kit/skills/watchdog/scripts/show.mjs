#!/usr/bin/env node
// Opens ONE flagged record by its ref (#unit:n) with a positional read — the transcript itself is never re-read.
//   node show.mjs --state <dir> '#u1:57' ['#u1:58' …] [--max 3000]
//   node show.mjs --state <dir> --list [unit] [--from m] [--to m] [--last 40]   refs kept in the state (by record time)
//   node show.mjs --state <dir> --ctx [unit]                biggest context jumps and what caused them
//   node show.mjs --state <dir> --open [unit]               open calls, bg tasks, async subagents per file
//   node show.mjs --state <dir> --pack <unit> [--from <mark>] [--to <mark>] [--max 60000]
//        every record of the unit (main + subagents) between two marks (setup, stage:<name>, ended), one compact
//        line each — the input of a stage audit; --marks <unit> lists the marks
import fs from 'node:fs';
import path from 'node:path';
import { SKIP_TYPES, age, hms, kc, loadState, nativePath, one, zone } from './lib/core.mjs';
import { readRef } from './lib/foreign.mjs';

const argv = process.argv.slice(2);
const val = (k, d) => {
  const i = argv.indexOf(`--${k}`);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : d;
};
const stateDir = path.resolve(nativePath(val('state', path.join(process.cwd(), '.agent', 'tmp', 'watchdog', 'default'))));
const s = loadState(stateDir);
const max = Number(val('max', 3000));
const unitArg = (k) => {
  const v = val(k, null);
  return v && !v.startsWith('#') ? v : null;
};

const clip = (t) => {
  const x = String(t ?? '');
  return x.length <= max ? x : `${x.slice(0, Math.floor(max * 0.6))}\n…[${kc(x.length - max)} chars cut]…\n${x.slice(-Math.floor(max * 0.4))}`;
};
function readAt(f, off, len) {
  const fd = fs.openSync(f, 'r');
  try {
    const b = Buffer.alloc(len);
    fs.readSync(fd, b, 0, len, off);
    return b.toString('utf8');
  } finally {
    fs.closeSync(fd);
  }
}
function render(r) {
  const out = [];
  const m = r.message;
  out.push(`${r.type}${r.subtype ? `:${r.subtype}` : ''}${r.attachment ? `:${r.attachment.type}` : ''} ${r.timestamp ?? ''}${m?.model ? ` ${m.model}` : ''}${m?.stop_reason ? ` stop=${m.stop_reason}` : ''}`);
  const c = m?.content;
  if (typeof c === 'string') out.push(clip(c));
  for (const p of Array.isArray(c) ? c : []) {
    if (p.type === 'text') out.push(clip(p.text));
    else if (p.type === 'tool_use') out.push(`tool_use ${p.name} ${p.id}\n${clip(JSON.stringify(p.input, null, 1))}`);
    else if (p.type === 'tool_result') {
      const t = typeof p.content === 'string' ? p.content : (p.content ?? []).map((x) => x.text ?? `[${x.type}]`).join('\n');
      out.push(`tool_result ${p.tool_use_id}${p.is_error ? ' is_error' : ''}\n${clip(t)}`);
    }
  }
  const tur = r.toolUseResult;
  if (tur && typeof tur === 'object') {
    const keep = ['interrupted', 'backgroundTaskId', 'persistedOutputPath', 'persistedOutputSize', 'agentId', 'status'];
    const meta = Object.fromEntries(keep.filter((k) => tur[k] !== undefined).map((k) => [k, tur[k]]));
    if (Object.keys(meta).length) out.push(`toolUseResult ${JSON.stringify(meta)}`);
    if (tur.stderr) out.push(`stderr: ${clip(tur.stderr)}`);
  }
  for (const k of ['toolDenialKind', 'permissionDecision', 'compactMetadata', 'hookErrors', 'error', 'attachment', 'content'])
    if (r[k] !== undefined && !(k === 'content' && r.type === 'user')) out.push(`${k}: ${clip(JSON.stringify(r[k]))}`);
  return out.join('\n');
}

// One record as one line: who, what, the gist — a pack of a whole stage stays readable in one context.
function brief(r) {
  const m = r.message;
  const c = m?.content;
  // Records carry UTC; the header, --list and --marks print local — one clock for all, named in each header (F-15).
  const ms = Date.parse(r.timestamp ?? '');
  const t = Number.isFinite(ms) ? hms(ms) : '--:--:--';
  if (typeof c === 'string') return `${t} ${r.type === 'user' ? 'USER' : 'TEXT'} ${one(c, 400)}`;
  const out = [];
  for (const p of Array.isArray(c) ? c : []) {
    if (p.type === 'text' && p.text?.trim()) out.push(`${t} ${r.type === 'user' ? 'USER' : 'TEXT'} ${one(p.text, 400)}`);
    else if (p.type === 'tool_use') out.push(`${t} CALL ${p.name} ${one(JSON.stringify(p.input), 300)}`);
    else if (p.type === 'tool_result') {
      const x = typeof p.content === 'string' ? p.content : (p.content ?? []).map((y) => y.text ?? `[${y.type}]`).join(' ');
      out.push(`${t} ${p.is_error ? 'ERR ' : 'RES '} ${one(x, 240)}`);
    }
  }
  if (!out.length && r.type === 'system') out.push(`${t} SYS ${r.subtype ?? ''} ${one(r.content ?? '', 200)}`);
  return out.join('\n');
}
/**
 * The two marks of a stretch. `--from` = the latest recorded mark of that name; `--to` = the FIRST mark of its name
 * recorded after `--from` (W1, g5 27.10: `--from stage:deliver --to ended` took the last `ended`, a day later, and
 * the pack mixed the 26.10 delivery tail with the 27.10 recheck), else the first of its name at or after `--from`'s
 * time. Recorded order, not `at`: a stage mark sits at the stage's own start, which may precede the `setup` it was
 * recorded after. No `--from` → the latest mark by its own time (a catch-up pass pushes marks out of order, g9 26.10:
 * conv:af47ee81 after stage:deliver), `--to` the latest recorded of its name.
 */
export function stretch(marks, fromName, toName) {
  const lastOf = (name) => [...marks].reverse().find((m) => m.name === name) ?? null;
  const from = fromName ? lastOf(fromName) : ([...marks].sort((x, y) => x.at - y.at).at(-1) ?? null);
  let to = null;
  if (toName && fromName && from) {
    to = marks.slice(marks.indexOf(from) + 1).find((m) => m.name === toName) ?? [...marks].sort((x, y) => x.at - y.at).find((m) => m.name === toName && m !== from && m.at >= from.at) ?? null;
  } else if (toName) to = lastOf(toName);
  return { from, to };
}
const day = (ms) => new Date(ms).toDateString();
const ymd = (ms) => {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};
/** Times of a span: HH:MM:SS, or date + time when the span crosses local midnight (W1: a 25-hour window read as 83 min). */
export const clockOf = (...span) => {
  const days = new Set(span.filter(Number.isFinite).map(day));
  return days.size > 1 ? (ms) => `${ymd(ms)} ${hms(ms)}` : hms;
};
function pack(unit) {
  const marks = s.marks?.[unit] ?? [];
  // A named mark that was never recorded is an error, not «the start» / «now»: the fallback packed a whole other
  // stretch as if it were the asked one (g5 26.10: the audit read the wrong window and never knew).
  const named = val('from', null);
  const toName = val('to', null);
  const { from, to } = stretch(marks, named, toName);
  // A --to that exists only before --from is named as such: the stretch asked for has no end yet.
  const before = toName && !to && from && marks.some((m) => m.name === toName);
  const lost = [named && !from ? `--from ${named}` : '', toName && !to ? `--to ${toName}${before ? ` after ${from.name}` : ''}` : ''].filter(Boolean);
  if (lost.length) {
    const at = clockOf(...marks.map((m) => m.at));
    console.log(`refused: mark not recorded for ${unit}: ${lost.join(', ')} — recorded: ${marks.map((m) => `${m.name} ${at(m.at)}`).join(', ') || 'none'} (show.mjs --marks ${unit})`);
    process.exitCode = 2;
    return;
  }
  const budget = Number(val('max', 60000));
  const files = Object.entries(s.files).filter(([, f]) => f.unit === unit && f.role !== 'log');
  let used = 0;
  const at = clockOf(from?.at, to ? to.at : Date.now());
  console.log(`== pack ${unit} from ${from ? `${from.name} ${at(from.at)}` : 'the start'} to ${to ? `${to.name} ${at(to.at)}` : 'now'} · ${files.length} file(s) · times ${zone()}`);
  for (const [f, st] of files) {
    if (st.whole) {
      console.log(`-- ${st.role} ${path.basename(f)}: ${st.fmt} document, read it by ref`);
      continue;
    }
    // A file the --to mark does not know did not exist yet then (or was born at it): it belongs after the mark
    // (W1, g5 25.10: verify 1dfd6a07 packed whole into a pack ending at stage:fix).
    // An event mark's `end` is no bound (core mark()): its stretch reads to the file's end and cuts by record time;
    // a file the mark never knew was found later, not born after it.
    const toEnd = !to ? st.offset : to.ev ? (f in (to.end ?? {}) || !(f in to.off) ? st.offset : undefined) : (to.end ?? to.off)[f];
    if (toEnd === undefined) continue;
    const a = from?.off?.[f] ?? 0;
    const b = toEnd;
    if (b <= a) continue;
    // Event marks (stamped at an event already past) bound by offsets loosely; the records' own times cut exactly.
    // A file born at --from belongs wholly to the stretch.
    const fromAt = from?.ev && !(from.off?.[f] === 0 && from.end?.[f] === undefined) ? from.at : null;
    const toAt = to?.ev ? to.at : null;
    let head = false;
    // A record with no timestamp goes with the last timed one before it: an event stretch read past its end keeps
    // the untimed records after the cut out too.
    let inside = fromAt === null;
    for (const l of readAt(f, a, b - a).split('\n')) {
      let r;
      try {
        r = JSON.parse(l);
      } catch {
        continue;
      }
      // Bookkeeping records (api-request blobs repeat every call and result with no timestamp) are no behaviour (W2).
      if (SKIP_TYPES.has(r.type)) continue;
      const ts = Date.parse(r.timestamp ?? '');
      if (Number.isFinite(ts)) inside = !((fromAt !== null && ts < fromAt) || (toAt !== null && ts >= toAt));
      if (!inside) continue;
      // The header after the cut: a file wholly outside the stretch prints nothing.
      if (!head) {
        head = true;
        console.log(`-- ${st.role}${st.desc ? ` «${one(st.desc, 60)}»` : ''} ${path.basename(f)} ${kc(b - a)}B`);
      }
      const x = brief(r);
      if (!x) continue;
      if (used + x.length > budget) {
        console.log(`…[pack cut at ${kc(budget)} chars — narrow with --from/--to or raise --max]`);
        return;
      }
      used += x.length;
      console.log(x);
    }
  }
}

const refs = argv.filter((a) => /^#?[^\s:#]+:\d+$/.test(a));
if (argv.includes('--pack')) {
  const unit = unitArg('pack');
  if (!unit || !s.units[unit]) console.log(`--pack needs a unit of this state: ${Object.keys(s.units).join(', ')}`);
  else pack(unit);
} else if (argv.includes('--marks')) {
  const unit = unitArg('marks');
  console.log(`== marks ${unit} · times ${zone()}`);
  const marks = [...(s.marks?.[unit] ?? [])].sort((x, y) => x.at - y.at);
  const at = clockOf(...marks.map((m) => m.at));
  for (const m of marks) console.log(`${at(m.at)} ${m.name}`);
} else if (argv.includes('--list')) {
  const only = unitArg('list');
  const last = Number(val('last', 40));
  // `--from`/`--to` = a stage's flags: refs by their record time between the unit's two marks (same pair as --pack).
  const [fromName, toName] = [val('from', null), val('to', null)];
  const pair = stretch(s.marks?.[only] ?? [], fromName, toName);
  const fromAt = fromName === null ? null : (pair.from?.at ?? NaN);
  const toAt = toName === null ? null : (pair.to?.at ?? NaN);
  if (Number.isNaN(fromAt) || Number.isNaN(toAt) || ((fromAt !== null || toAt !== null) && !only)) {
    console.log(`refused: --from/--to need a unit and its recorded marks (show.mjs --marks ${only ?? '<unit>'})`);
    process.exitCode = 2;
  }
  const within = (x) => (fromAt === null || x.at >= fromAt) && (toAt === null || x.at < toAt);
  console.log(`== refs · times ${zone()}`);
  for (const [u, r] of Object.entries(process.exitCode ? {} : s.refs)) {
    if (only && u !== only) continue;
    for (const x of r.ring.filter(within).slice(-last)) console.log(`#${u}:${x.n} ${hms(x.at)} ${x.tag} ${x.f ? `${path.basename(x.f)}@${x.off ?? `#${x.idx}`} ${kc(x.len ?? 0)}B` : one(x.text, 100)}`);
  }
} else if (argv.includes('--ctx')) {
  const only = unitArg('ctx');
  for (const [f, st] of Object.entries(s.files)) {
    if ((only && st.unit !== only) || !st.ctxTop?.length) continue;
    console.log(`${st.unit} ${path.basename(f)} ctx now ${kc(st.ctx)}`);
    for (const x of st.ctxTop) console.log(`  +${kc(x.d)} → ${kc(x.ctx)} ${hms(x.at)} ${x.cause ? `after ${x.cause}` : ''} ${x.ref}`);
  }
} else if (argv.includes('--open')) {
  const only = unitArg('open');
  const now = Date.now();
  for (const [f, st] of Object.entries(s.files)) {
    if (only && st.unit !== only) continue;
    const open = Object.values(st.open ?? {});
    const bg = Object.entries(st.bg ?? {});
    const subs = Object.entries(st.subs ?? {});
    if (!open.length && !bg.length && !subs.length) continue;
    console.log(`${st.unit} ${st.role} ${path.basename(f)} turnEnded=${st.turnEnded}`);
    for (const o of open) console.log(`  open ${o.name} ${age(now - o.at)} ${one(o.b, 120)}`);
    for (const [id, v] of bg) console.log(`  bg ${id} ${age(now - v.at)} ${one(v.b, 100)}`);
    for (const [id, v] of subs) console.log(`  sub ${id} ${age(now - v.at)} ${one(v.b, 100)}`);
  }
} else if (refs.length) {
  for (const a of refs) {
    const [u, n] = a.replace(/^#/, '').split(':');
    const x = s.refs[u]?.ring.find((y) => y.n === Number(n));
    if (!x) {
      console.log(`${a}: not in the ring (kept: last ${s.refs[u]?.ring.length ?? 0} refs of ${u})`);
      continue;
    }
    if (!x.f) {
      console.log(`== ${a} ${x.tag} (no transcript record — the flag's own text)\n${x.text ?? ''}`);
      continue;
    }
    // A foreign whole-document record has an index, not a byte range.
    const raw = x.idx !== undefined && x.idx !== null ? (readRef({ f: x.f, idx: x.idx, fmt: s.files[x.f]?.fmt, keys: s.files[x.f]?.fx?.keys, drop: s.files[x.f]?.fx?.drop }) ?? '') : readAt(x.f, x.off, x.len);
    let body;
    try {
      body = render(JSON.parse(raw));
    } catch {
      body = clip(raw);
    }
    console.log(`== ${a} ${x.tag} ${x.f}@${x.off ?? `#${x.idx}`}\n${body}`);
  }
} else console.log('usage: show.mjs --state <dir> <#unit:n …> [--max 3000] | --list [unit] [--from m] [--to m] [--last 40] | --ctx [unit] | --open [unit] | --pack <unit> [--from m] [--to m] | --marks <unit>');
