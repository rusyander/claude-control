// watchdog call loop: units in, one blocking call out. Wakes 8 s after the first hi flag (settle collects what
// follows it), 90 s after the first mid flag, or at --max with a quiet footer. Polls the filesystem in-process —
// no shell sleep, no model turn while idle. A plugin may add units, scans and footer parts.
import path from 'node:path';
import { DEFAULTS, T, Watcher, age, configRoot, digest, discover, footerLine, hms, insideOf, kc, loadState, nativePath, parseUnitSpec, saveState, takeLock } from './core.mjs';
import { coordinatorOf, ledgerDirFor, owedRefs, registerWatcher, stopWatcher, unrowed } from './keepalive.mjs';

export const USAGE = `watch.mjs — blocking live watch over agent transcripts and logs
  --state <dir>              state + lock dir (outside every watched copy; persisted offsets live here)
  --unit name=kind:target    kind: dir (transcript dir) | cwd (session cwd → projects/<slug>) | file (one .jsonl)
                             | session (id, searched under projects/) | log (plain text file). Repeatable; units persist.
  --drop name                forget a unit
  --max 285 --settle 8 --batch 90 --poll 2 --budget 8000 --backlog 12 --stall 600
  --from end|start           new units start at the end (tail seeded) or read from byte 0 (fixtures)
  --once                     one pass, print, no wait
  --config-root <dir>        Claude config root (default CLAUDE_CONFIG_DIR or ~/.claude)
  --ledger-dir <dir>         ledgers + inbox (default <P>/.agent/live-watch when the state is under <P>/.agent/tmp/watchdog):
                             a call is refused while a flag of the last digest has no row citing its #ref
  --stop "<owner's words>"   end the keepalive: the words must be in a message the owner typed since the watch began
  --no-keepalive             this call does not register the session (the Stop guard keeps a coordinator's turn alive)
Exit: 0 digest printed · 2 usage/refusal · 3 another call holds the lock.`;

export function parseArgs(argv, valueFlags = [], multiFlags = []) {
  const o = { ...DEFAULTS, unit: [], drop: [], _: [] };
  const VAL = new Set(['state', 'max', 'settle', 'batch', 'poll', 'budget', 'backlog', 'from', 'config-root', 'stall', 'ledger-dir', 'stop', ...valueFlags]);
  const MULTI = new Set(['unit', 'drop', ...multiFlags]);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) {
      o._.push(a);
      continue;
    }
    const k = a.slice(2);
    if (MULTI.has(k)) (o[k] ??= []).push(argv[++i]);
    else if (VAL.has(k)) o[k] = argv[++i];
    else o[k] = true;
  }
  for (const k of ['max', 'settle', 'batch', 'poll', 'budget', 'backlog', 'stall']) if (o[k] !== undefined) o[k] = Number(o[k]);
  return o;
}

function dropUnit(s, name) {
  delete s.units[name];
  // The ref counter survives: a unit added back must never reuse a #ref an old ledger row already cites.
  if (s.refs[name]) s.refs[name].ring = [];
  for (const [f, st] of Object.entries(s.files)) if (st.unit === name) delete s.files[f];
}

export async function runWatch(argv, plugin = {}) {
  const o = parseArgs(argv, plugin.valueFlags, plugin.multiFlags);
  if (o.help) {
    console.log(plugin.usage ? `${USAGE}\n${plugin.usage}` : USAGE);
    return 0;
  }
  const stateDir = path.resolve(nativePath(o.state ?? path.join(process.cwd(), '.agent', 'tmp', 'watchdog', 'default')));
  const root = configRoot(o);
  if (o.stop) {
    const r = stopWatcher(root, String(o.stop));
    console.log(r.text);
    return r.code;
  }
  // A plugin resolves what the flags left open before anything reads (agentdeck: the panel's data dir).
  await plugin.prepare?.(o);
  const s = loadState(stateDir);
  const ledgerDir = ledgerDirFor(stateDir, o['ledger-dir'] ? nativePath(o['ledger-dir']) : null, s.ledgerDir);
  if (o['ledger-dir']) s.ledgerDir = ledgerDir;
  if (o.stall) T.stallSec = o.stall;
  for (const d of o.drop) dropUnit(s, d);
  const added = [];
  const addUnit = (name, kind, target, extra = {}) => {
    const cur = s.units[name];
    if (cur && cur.kind === kind && cur.target === target) return cur;
    if (cur) dropUnit(s, name);
    s.units[name] = { kind, target, addedAt: Date.now(), ...extra };
    added.push(name);
    return s.units[name];
  };
  for (const spec of o.unit) {
    const p = parseUnitSpec(spec ?? '');
    if (!p) {
      console.log(`bad --unit "${spec}" — expected name=dir|cwd|file|session|log:<target>\n${USAGE}`);
      return 2;
    }
    addUnit(p.name, p.kind, p.target);
  }
  const ctx = { s, o, stateDir, added, addUnit, w: null, emit: null };
  if (plugin.units) {
    const err = plugin.units(ctx);
    if (err) {
      console.log(err);
      return 2;
    }
  }
  if (!Object.keys(s.units).length) {
    // The last unit dropped: the drop is saved, else re-adding the same unit keeps its old offsets and never
    // re-seeds the tail.
    if (o.drop.length) {
      const lockErr = takeLock(stateDir, o.max);
      if (lockErr) {
        console.log(lockErr);
        return 3;
      }
      saveState(stateDir, s);
      console.log(`dropped ${o.drop.join(', ')} — no units left, state saved`);
      return 0;
    }
    console.log(`no units — pass --unit name=kind:target\n${USAGE}`);
    return 2;
  }
  // The state must never land inside a watched copy: the watch writes nothing into the work it watches.
  for (const [name, u] of Object.entries(s.units)) {
    discover(u, o);
    const roots = [u.cwd, u.kind === 'cwd' ? u.target : null, u.copy].filter(Boolean);
    if (roots.some((r) => insideOf(stateDir, r))) {
      console.log(`refused: state dir ${stateDir} is inside the watched copy of unit "${name}" (${roots.join(', ')}) — pick a dir outside it`);
      return 2;
    }
  }
  // A flag the last digest showed and no row cites is a finding lost: no new digest until each one has its row.
  const owed = Object.values(s.units).some((u) => u.kind !== 'log') ? unrowed(s.lastRefs, ledgerDir) : [];
  if (owed.length) {
    // No pass runs while rows are owed, yet what stands still must be named here: g1 26.10 #g1:118 paused, due 18:48,
    // three refused calls and no pass until 19:46 — the overdue nag lived in the pass the refusal skipped.
    const standing = (await plugin.refused?.(ctx)) ?? [];
    console.log(
      `refused: ${owed.length} flag(s) of the last digest have no row in ${ledgerDir} — cite each #ref in a ledger or inbox row (one row may cite several), then call again:\n${owed.map((r) => `  ${r.ref} ${r.tag} ${r.text}`).join('\n')}${standing.length ? `\nstill standing while you write them:\n${standing.map((l) => `  ${l}`).join('\n')}` : ''}`,
    );
    return 2;
  }
  const lockErr = takeLock(stateDir, o.max);
  if (lockErr) {
    console.log(lockErr);
    return 3;
  }

  const w = new Watcher(s, o);
  ctx.w = w;
  // A plugin names a conversation born mid-watch from its first prompt (a stage brief → stage:<x>); core marks it.
  if (plugin.convName) w.convName = (text, st) => plugin.convName(text, st, ctx);
  // A plugin names a unit whose turn the host cut (paused, done…): core ends that turn at its last record.
  if (plugin.stopped) w.stopped = (name) => plugin.stopped(name, ctx);
  ctx.emit = (unit, sev, tag, text) => w.emit(unit, sev, tag, text, Date.now(), null);
  const t0 = Date.now();
  let seen = 0;
  let firstHi = 0;
  let firstMid = 0;
  const mark = () => {
    for (; seen < w.events.length; seen++) {
      const e = w.events[seen];
      if (e.sev === 'hi' && !firstHi) firstHi = Date.now();
      if (e.sev === 'mid' && !firstMid) firstMid = Date.now();
    }
  };
  const step = async (fresh) => {
    w.pass(fresh);
    plugin.scan?.(ctx);
    w.ticks();
    await plugin.after?.(ctx);
    mark();
  };
  await step(new Set(added));
  // Where the watch of a unit began: show.mjs --pack <unit> --since setup reads everything after it.
  for (const name of added) w.mark(name, 'setup');
  const setup = added.length > 0 && o.from !== 'start';
  let wake = setup ? 'setup' : o.once ? 'once' : null;
  while (!wake) {
    const now = Date.now();
    if (firstHi && now - firstHi >= o.settle * 1000) wake = 'hi';
    else if (!firstHi && firstMid && now - firstMid >= o.batch * 1000) wake = 'batch';
    else if (now - t0 >= o.max * 1000) wake = 'max';
    if (wake) break;
    await new Promise((r) => setTimeout(r, Math.max(50, o.poll * 1000)));
    await step(new Set());
  }
  const now = Date.now();
  const footers = Object.keys(s.units).map((name) => {
    const st = w.status(name);
    return footerLine(name, st, plugin.footer?.(ctx, name, st) ?? '');
  });
  // One line naming every source the plugin watches and whether it was read — a blind area shows as ✗.
  const cover = plugin.cover?.(ctx);
  if (cover) footers.push(cover);
  // A flag a plugin folded into another line (`folded` = that line) is told there: not shown, no row owed.
  let events = w.events.filter((e) => !e.folded);
  const hi = events.filter((e) => e.sev === 'hi').length;
  const mid = events.filter((e) => e.sev === 'mid').length;
  const header = `watch ${hms(t0)}→${hms(now)} ${age(now - t0)} wake=${wake} · read ${kc(w.bytes)}B · hi ${hi} mid ${mid}`;
  if (setup) {
    const back = w.backlog.filter((e) => e.sev !== 'lo').slice(-o.backlog);
    if (back.length) events = [{ unit: '—', sev: 'mid', tag: 'BACKLOG', text: `last ${back.length} flags before the watch started:`, at: back[0].at - 1, ref: '' }, ...back, ...events];
  }
  s.lastWake = now;
  s.lastRefs = ledgerDir ? owedRefs(events) : [];
  // The coordinator's session stays alive past its turn end (hooks/lib/watch-keepalive.mjs) until the owner's
  // stop, hold.json, or every group done/failed (the plugin's ctx.done).
  const co = o['no-keepalive'] ? null : coordinatorOf(stateDir, s.units);
  if (co) {
    const cmd = plugin.cmd?.(ctx) ?? `node ${path.resolve(process.argv[1] ?? 'watch.mjs').replace(/\\/g, '/')} --state ${stateDir.replace(/\\/g, '/')}`;
    const rec = registerWatcher(root, stateDir, co, { cmd, allDone: !!ctx.done?.all, live: ctx.done?.live ?? co.live, why: ctx.done?.why ?? '' });
    footers.push(`keepalive ${rec.allDone ? 'released (all done)' : 'on'} · the turn ends on --stop "<owner's words>", hold.json, or every group done/failed`);
  }
  if (s.lastRefs.length) footers.push(`rows owed before the next call: ${s.lastRefs.map((r) => r.ref).join(' ')}`);
  saveState(stateDir, s);
  console.log(digest({ events, header, footers, budget: o.budget }));
  return 0;
}
