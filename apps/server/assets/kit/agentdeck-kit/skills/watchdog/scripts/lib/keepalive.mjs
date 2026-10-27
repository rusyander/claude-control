// Keepalive + row discipline of a coordinator watch.
//
// Keepalive: a watch call made from a Claude session (CLAUDE_CODE_SESSION_ID) over a state dir under
// <P>/.agent/tmp/watchdog/ with at least one non-log unit registers that session in
// <config>/cache/watchers/<sid>.json (a kit copy: <kit state>/watchers, watchersDir). The Stop guard
// (hooks/lib/watch-keepalive.mjs, personal or kit) reads it and blocks the
// turn end while the watch is live: the watcher ends its turn only on the owner's quoted stop, hold.json, or
// every group done/failed (watcher.json `allDone`). A log-only unit set (the parity agent's feed) never
// registers; selftests strip the env.
//
// Rows: every flag of the last digest that is not plain information (INFO) must be cited by its ref
// (`#unit:n`) in a ledger or inbox row before the next watch call runs — a flag nobody rowed is a finding lost.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { kitRoot, kitStateDir } from './where.mjs';

// Plain information: the coordinator reads it, it is not a deviation by itself. Anything carrying waste or
// burn is never INFO, whatever its tag.
// BGDONE is information only when the task ended well (a killed or failed one is hi).
export const INFO_TAGS = new Set(['END', 'NEWCONV', 'SPAWN', 'SUB', 'BG', 'LOG', 'BACKLOG', 'HINT', 'RUN', 'STAGE', 'WINDOW', 'COVER', 'NEXT']);
const isInfo = (e) => !e.waste && !e.burn && (INFO_TAGS.has(e.tag) || (e.tag === 'BGDONE' && e.sev !== 'hi'));

const WATCH_RE = /^(.*)[\\/]\.agent[\\/]tmp[\\/]watchdog(?:[\\/]|$)/;

/** The project root P of a state dir under P/.agent/tmp/watchdog/, else null. */
export function projectOf(stateDir) {
  const m = WATCH_RE.exec(String(stateDir ?? ''));
  return m ? m[1] : null;
}

export function ledgerDirFor(stateDir, explicit, saved) {
  if (explicit) return path.resolve(explicit);
  if (saved) return saved;
  const p = projectOf(stateDir);
  const d = p ? path.join(p, '.agent', 'live-watch') : null;
  return d && fs.existsSync(d) ? d : null;
}

/**
 * Where the keepalive registry lives: a personal-layer copy → <config>/cache/watchers (read by the personal Stop
 * hook); a kit copy → <kit state>/watchers (read by the kit's `watch-keepalive` item). One reader per registry, so
 * the two Stop hooks never block the same turn twice.
 */
export const watchersDir = (root, kit = kitRoot()) => (kit ? path.join(kitStateDir(), 'watchers') : path.join(root, 'cache', 'watchers'));
export const registryFile = (root, sid) => path.join(watchersDir(root), `${String(sid).replace(/[^\w.-]/g, '_')}.json`);

/** Is this call a coordinator watch: a Claude session, a project state dir, a unit that is not a plain log. */
export function coordinatorOf(stateDir, units) {
  const sid = process.env.CLAUDE_CODE_SESSION_ID || '';
  const repo = projectOf(stateDir);
  const live = Object.entries(units).filter(([, u]) => u.kind !== 'log').map(([n]) => n);
  return sid && repo && live.length ? { sid, repo, live } : null;
}

const readJson = (f) => {
  try {
    return JSON.parse(fs.readFileSync(f, 'utf8'));
  } catch {
    return null;
  }
};
const writeJson = (f, v) => {
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, `${JSON.stringify(v, null, 1)}\n`);
};

/**
 * Registers (or refreshes) the watcher. `cmd` is what the Stop guard tells the model to run next. Every call
 * resets the guard's block counter: a fresh wake re-arms it.
 */
export function registerWatcher(root, stateDir, co, { cmd, allDone = false, live = co.live, why = '' } = {}) {
  const f = registryFile(root, co.sid);
  const prev = readJson(f);
  const rec = { sid: co.sid, stateDir, repo: co.repo, since: prev?.stateDir === stateDir ? prev.since : Date.now(), at: Date.now(), blocks: 0, cmd, allDone, live, why };
  writeJson(f, rec);
  writeJson(path.join(stateDir, 'watcher.json'), rec);
  return rec;
}

/** The owner's typed messages in a session transcript since `since` (ms). Tail only — transcripts reach 100 MB. */
export function ownerMessages(root, sid, since = 0) {
  const proj = path.join(root, 'projects');
  let file = null;
  try {
    for (const d of fs.readdirSync(proj)) {
      const f = path.join(proj, d, `${sid}.jsonl`);
      if (fs.existsSync(f)) file = f;
    }
  } catch {
    return [];
  }
  if (!file) return [];
  const size = fs.statSync(file).size;
  const len = Math.min(size, 6 * 1024 * 1024);
  const buf = Buffer.alloc(len);
  const fd = fs.openSync(file, 'r');
  fs.readSync(fd, buf, 0, len, size - len);
  fs.closeSync(fd);
  const out = [];
  for (const l of buf.toString('utf8').split('\n')) {
    let r;
    try {
      r = JSON.parse(l);
    } catch {
      continue;
    }
    if (r?.type !== 'user' || r.isCompactSummary || r.isMeta) continue;
    if (since && Date.parse(r.timestamp ?? '') < since) continue;
    const c = r.message?.content;
    const text = typeof c === 'string' ? c : Array.isArray(c) ? c.filter((x) => x?.type === 'text').map((x) => x.text).join('\n') : '';
    const clean = text.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '').replace(/<ide_[a-z_]+>[\s\S]*?<\/ide_[a-z_]+>/g, '').trim();
    if (clean && !/^<(?:command-|local-command-)/.test(clean)) out.push(clean);
  }
  return out;
}

const norm = (t) => String(t).toLowerCase().replace(/[«»"“”'`]/g, '').replace(/\s+/g, ' ').trim();

/** `--stop "<owner's words>"`: the words must be the owner's, typed in this session after the watch began. */
export function stopWatcher(root, words) {
  const sid = process.env.CLAUDE_CODE_SESSION_ID || '';
  if (!sid) return { code: 2, text: 'refused: --stop needs the Claude session (CLAUDE_CODE_SESSION_ID) — nothing is registered without it' };
  const f = registryFile(root, sid);
  const rec = readJson(f);
  if (!rec) return { code: 0, text: 'no keepalive registered for this session' };
  const q = norm(words);
  if (q.length < 2) return { code: 2, text: 'refused: --stop needs the owner\'s words, quoted from their message' };
  const said = ownerMessages(root, sid, rec.since).some((m) => norm(m).includes(q));
  if (!said)
    return { code: 2, text: `refused: «${words}» is not in any message the owner typed since the watch began (${new Date(rec.since).toISOString()}) — the watch ends on the owner's word, quoted exactly` };
  fs.rmSync(f, { force: true });
  writeJson(path.join(rec.stateDir, 'watcher.json'), { ...rec, stopped: { at: Date.now(), words } });
  return { code: 0, text: `keepalive off — the owner said: «${words}»` };
}

const reEsc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Ledger files: `<dir>/*.md` plus the doc-hygiene archive `<dir>/../archive/<dir name>/*.md`. An archived row
 * is still a row (25.10: terminal rows moved out of a 24 KB ledger, and the next call owed refs they cited).
 */
export function ledgerFiles(ledgerDir) {
  const out = [];
  const archive = path.join(path.dirname(ledgerDir), 'archive', path.basename(ledgerDir));
  for (const [dir, prefix] of [[ledgerDir, ''], [archive, 'archive/']]) {
    let names;
    try {
      names = fs.readdirSync(dir);
    } catch {
      continue;
    }
    for (const f of names) if (f.endsWith('.md')) out.push({ f: `${prefix}${f}`, path: path.join(dir, f) });
  }
  return out;
}

/** Refs of the last digest that no ledger/inbox row cites. */
export function unrowed(lastRefs, ledgerDir) {
  if (!ledgerDir || !lastRefs?.length) return [];
  let text = '';
  try {
    for (const { path: f } of ledgerFiles(ledgerDir)) text += fs.readFileSync(f, 'utf8');
  } catch {
    return [];
  }
  // A row citing several flags of one unit as a list `#g5:95,96,101` cites each (g5 25.10: the list was read as
  // #g5:95 alone and the watch refused the next call for 96 and 101, ~18 min of the coordinator's turn).
  // Any unit name, the panel-wide «—» included (26.10: `#—:51,52,53` cited 51 alone).
  text = text.replace(/#([^\s:#,|]+):(\d+)((?:,\d+)+)/g, (all, u, _first, rest) => `${all} ${rest.slice(1).split(',').map((n) => `#${u}:${n}`).join(' ')}`);
  return lastRefs.filter((r) => !new RegExp(`${reEsc(r.ref)}(?!\\d)`).test(text));
}

/** The refs a digest owes rows for. */
export function owedRefs(events) {
  return events.filter((e) => e.ref && e.sev !== 'lo' && !isInfo(e)).map((e) => ({ ref: e.ref, tag: e.tag, text: String(e.text).slice(0, 90) }));
}

export const defaultRoot = () => process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
