// Learned command durations: a command known to be slow runs in the background, or with a timeout
// that fits it, instead of being killed at the cap and run again.
//
// Measured week: 144 Bash calls killed at the 600 s cap, 127 min lost plus the
// re-run after each; QA/browser scripts were 69 of them. The Bash default timeout is 120 s, so a 5-min
// suite started without `timeout` dies at 2 min every time. Durations are learned here: PreToolUse
// stamps the start by tool_use_id, PostToolUse — or PostToolUseFailure, all a call ending non-zero
// gets — closes it (Codex has no failure event: its PostToolUse runs for a non-zero Bash too, hooks
// docs); a kill is counted only from a response saying the command timed out. A start never
// closed (interrupt, refused permission) is dropped: counting it as a kill once turned every failed 1 s
// call into a «600 s, killed» record.
// Keyed by main repo root + bare command: the store held 0 gate keys of 150 while one group ran its gate
// 9× in 7 spellings (`cd X;`, `export PATH=…;`, `VAR=1`, `> gatesN.log`, `| tail`), each group from a
// fresh worktree. Known long gates (KNOWN_GATES) answer before anything is learned.
// Verdicts (repeat of the identical call = escape):
//   · main session, foreground, learned ≥ 300 s or killed before → run_in_background (notification wakes);
//   · any session, learned > the call's timeout (default 120 s) → raise `timeout` (cap 600000 ms);
//   · subagent, learned ≥ 540 s or killed before → narrow or split it, the foreground cap is 600 s
//     (a known gate is not narrowed: it only gets the timeout).
import { mkdirSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { backgroundParam, hasShellTimeout, stateDir } from './kit-paths.mjs';
import {
  deny,
  inSubagent,
  ownTranscript,
  readTail,
  toolEvents,
  wasJustRefused,
} from './transcript.mjs';

// Case is folded only where the disk ignores it: on Linux `App` and `app` are two repos.
const foldCase = (text) =>
  process.platform === 'win32' || process.platform === 'darwin' ? text.toLowerCase() : text;

const FILE = join(stateDir('durations'), 'cmd-durations.json');
const CAP_S = 600;
const KEEP_KEYS = 400;
const KEEP_RUNS = 5;

/** The previous key; still looked up so learned durations survive the change. */
export function legacyKey(cwd, command) {
  const cmd = String(command)
    .replace(/\s+2>&1/g, '')
    .replace(/\s*\|\s*(tail|head)(\s+-n)?\s+-?\d+\s*$/i, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 300);
  return `${foldCase(String(cwd ?? ''))}|${cmd}`;
}

// Top-level split of a shell line, quotes and $( ) respected. kind 'list' = ; && || newline; 'pipe' = |.
function splitTop(text, kind) {
  const out = [];
  let cur = '';
  let q = '';
  let depth = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '\\' && q === '"') {
        cur += c + (text[++i] ?? '');
        continue;
      }
      if (c === q) q = '';
      cur += c;
      continue;
    }
    if (c === '\\') {
      cur += c + (text[++i] ?? '');
      continue;
    }
    if (c === '"' || c === "'") q = c;
    else if (c === '(') depth++;
    else if (c === ')') depth = Math.max(0, depth - 1);
    else if (!depth) {
      const two = text.slice(i, i + 2);
      const cut =
        kind === 'list'
          ? c === ';' || c === '\n' || two === '&&' || two === '||'
          : c === '|' && two !== '||' && text[i - 1] !== '|';
      if (cut) {
        out.push(cur);
        cur = '';
        if (kind === 'list' && (two === '&&' || two === '||')) i++;
        continue;
      }
    }
    cur += c;
  }
  out.push(cur);
  return out.map((x) => x.trim()).filter(Boolean);
}

const ASSIGN = /^[A-Za-z_]\w*=(?:"(?:\\.|[^"\\])*"|'[^']*'|[^\s;&|]*)\s*/;
// Output filters after a pipe, and segments that only set up or read back around the real command.
const FILTER = /^(?:grep|egrep|rg|tail|head|sort|uniq|wc|cut|sed|awk|tee|cat|less|more|tr)\b/;
const NOISE =
  /^(?:cd|pushd|popd|export|echo|printf|rm|true|false|:|set|sleep|date|tail|head|cat|grep|egrep|rg|wc|ls|test|\[\[?|node\s+(?:-v|--version)|git\s+(?:diff|status|log|show|rev-parse|branch)\b)(?:\s|$)/;

function bareSegment(seg) {
  const stages = splitTop(seg, 'pipe');
  let s = stages.slice(1).every((st) => FILTER.test(st)) ? stages[0] : stages.join(' | ');
  s = s
    .replace(/(^|\s)\d?>&\d/g, '$1')
    .replace(/(^|\s)(?:\d?>>?|&>>?)\s*(?:"[^"]*"|'[^']*'|[^\s;&|]+)/g, '$1')
    .trim();
  while (ASSIGN.test(s)) s = s.replace(ASSIGN, '');
  return s.replace(/\s+/g, ' ').trim();
}

function cdTarget(dir, arg) {
  let p = String(arg ?? '').replace(/^["']|["']$/g, '');
  if (!p || p === '-') return dir;
  if (p === '~' || p.startsWith('~/')) p = join(homedir(), p.slice(1));
  else if (process.platform === 'win32' && /^\/[a-z](?:\/|$)/i.test(p))
    p = `${p[1]}:${p.slice(2) || '/'}`;
  return isAbsolute(p) ? p : resolve(dir, p);
}

/** The main repository's root (a worktree maps to its main checkout), else the folder itself. */
export function repoRoot(dir) {
  const start = resolve(String(dir || '.'));
  let root = start;
  for (let p = start; ; p = dirname(p)) {
    try {
      const st = statSync(join(p, '.git'));
      root = p;
      if (st.isFile()) {
        const gitdir =
          /gitdir:\s*(.+)/.exec(readFileSync(join(p, '.git'), 'utf8'))?.[1]?.trim() ?? '';
        const main = /^(.*?)[\\/]\.git[\\/]worktrees[\\/]/.exec(gitdir)?.[1];
        if (main) root = main;
      }
      break;
    } catch {
      /* no .git here */
    }
    if (dirname(p) === p) break;
  }
  try {
    root = realpathSync.native(root);
  } catch {
    /* keep as is */
  }
  return foldCase(root.replace(/\\/g, '/').replace(/\/$/, ''));
}

export function commandKey(cwd, command) {
  const raw = String(command);
  let dir = String(cwd ?? '');
  let cmd;
  if (raw.includes('<<')) cmd = raw.replace(/\s+/g, ' ').trim();
  else {
    const segs = splitTop(raw, 'list');
    for (const s of segs) {
      const m = /^cd\s+("[^"]*"|'[^']*'|\S+)\s*$/.exec(s);
      if (!m) break;
      dir = cdTarget(dir, m[1]);
    }
    const bare = segs.map(bareSegment).filter(Boolean);
    const kept = bare.filter((s) => !NOISE.test(s));
    cmd = (kept.length ? kept : bare).join(' ; ');
  }
  return `${repoRoot(dir)}|${cmd.slice(0, 300)}`;
}

// The kit's own gates known to take minutes (a project's gates are learned): answered before anything is learned. Matched on
// the script run by an interpreter in a bare segment, so a grep naming one is not a gate.
const KNOWN_GATES = [
  { file: /^mustfail\.mjs$/i, not: /\s(?:--help|-h|--dry)\b/ },
  { file: /^gate-run\.mjs$/i, not: /\s(?:--help|-h|--dry)\b/ },
];
const RUN = /^(?:node|bun|tsx|python3?|bash|sh)(?:\s+-{1,2}[\w-]+(?:=\S+)?)*\s+["']?([^\s"']+)/;

/** A known long gate in the command → a learned-shaped entry, else null. */
export function knownGate(command) {
  const raw = String(command ?? '');
  if (raw.includes('<<')) return null;
  for (const s of splitTop(raw, 'list').map(bareSegment)) {
    const file = RUN.exec(s)?.[1];
    if (!file) continue;
    const g = KNOWN_GATES.find((x) => x.file.test(basename(file)));
    if (g && (!g.need || g.need.test(s)) && (!g.not || !g.not.test(s)))
      return { median: CAP_S, kills: 0, n: 0, gate: true };
  }
  return null;
}

/** What is known of a command here: learned (new key, then legacy), else a known gate. */
export function knownFor(store, cwd, command) {
  return (
    learned(store.keys[commandKey(cwd, command)]) ??
    learned(store.keys[legacyKey(cwd, command)]) ??
    knownGate(command)
  );
}

export function loadStore(file = FILE) {
  try {
    const s = JSON.parse(readFileSync(file, 'utf8'));
    return { keys: s.keys ?? {}, pending: s.pending ?? {} };
  } catch {
    return { keys: {}, pending: {} };
  }
}

function saveStore(store, file = FILE) {
  try {
    const keys = Object.entries(store.keys)
      .sort((a, b) => (b[1].last ?? 0) - (a[1].last ?? 0))
      .slice(0, KEEP_KEYS);
    const pending = Object.entries(store.pending).filter(
      ([, p]) => Date.now() - p.t < 24 * 3600_000,
    );
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(
      file,
      JSON.stringify({ keys: Object.fromEntries(keys), pending: Object.fromEntries(pending) }),
    );
  } catch {
    /* an optimisation: a lost write forgets one duration */
  }
}

function addRun(store, key, seconds, killed) {
  const entry = store.keys[key] ?? { runs: [], kills: 0 };
  entry.runs = [...entry.runs, Math.round(seconds)].slice(-KEEP_RUNS);
  if (killed) entry.kills = (entry.kills ?? 0) + 1;
  entry.last = Date.now();
  store.keys[key] = entry;
}

/** Starts never closed for longer than the cap carry no duration — dropped, never a kill. */
export function settleStale(store, now = Date.now()) {
  for (const [id, p] of Object.entries(store.pending))
    if (now - p.t > (CAP_S + 30) * 1000) delete store.pending[id];
}

export function learned(entry) {
  if (!entry || entry.runs.length === 0) return null;
  const sorted = [...entry.runs].sort((a, b) => a - b);
  return {
    median: sorted[Math.floor(sorted.length / 2)],
    kills: entry.kills ?? 0,
    n: entry.runs.length,
  };
}

/** The verdict for a call given what is known of its command; pure for tests. */
export function verdict({
  known,
  background,
  timeoutMs,
  subagent,
  foregroundOnly = false,
  bgParam = 'run_in_background',
  timeoutParam = true,
}) {
  if (!known || background) return null;
  const slow = known.median >= 300 || known.kills > 0;
  const seen = known.gate
    ? 'is a known long gate (often over 10 min'
    : `took ~${known.median} s here (${known.n} run(s)` +
      `${known.kills ? `, ${known.kills} killed at the ${CAP_S} s cap` : ''}`;
  // A split group or a local-model run stays in the foreground (gate-at-end allows it there): the
  // panel reads the end of a group's turn as its result, and local-discipline refuses background.
  // A CLI whose shell has no background flag (bgParam null) cannot obey the advice at all.
  if (!subagent && slow && !foregroundOnly && bgParam)
    return (
      `cmd-duration: this command ${seen}). Run it with ${bgParam}: true — ` +
      'its completion notification wakes you — and do other work meanwhile, or narrow it. Repeat this exact call ' +
      'to run it in the foreground anyway.'
    );
  if (subagent && !known.gate && (known.median >= 540 || known.kills > 0))
    return (
      `cmd-duration: this command took ~${known.median} s here` +
      `${known.kills ? ` and was killed at the ${CAP_S} s cap ${known.kills}×` : ''}; a subagent has no background ` +
      'wake-up and the foreground cap is 600 s. Narrow it (one file, --quick) or split it. Repeat this exact call ' +
      'to try anyway.'
    );
  const limit = (timeoutMs ?? 120_000) / 1000;
  const raise = Math.min(600_000, Math.ceil(known.median * 1.5) * 1000);
  // Never advise the timeout the call already passes (a 580 s command under 600000 was refused).
  if (timeoutParam && known.median > limit * 0.9 && raise > limit * 1000)
    return (
      `cmd-duration: this command ${known.gate ? 'is a known long gate' : `took ~${known.median} s here`} ` +
      `but the call's timeout is ${Math.round(limit)} s (default 120 s) — it would be killed and re-run. ` +
      `Pass timeout: ${raise}. Repeat this exact call to keep the timeout.`
    );
  return null;
}

export default function cmdDurationPre(input, file = FILE) {
  const tool = input?.tool_name;
  if (tool !== 'Bash' && tool !== 'PowerShell') return null;
  const command = String(input.tool_input?.command ?? '');
  if (!command.trim()) return null;
  const key = commandKey(input.cwd, command);
  const store = loadStore(file);
  settleStale(store);
  const background = input.tool_input?.run_in_background === true;
  const text = verdict({
    known: knownFor(store, input.cwd, command),
    background,
    timeoutMs: Number(input.tool_input?.timeout) || undefined,
    subagent: inSubagent(input),
    foregroundOnly:
      Boolean(process.env.AGENTDECK_HEAVY_QUEUE_DIR) ||
      (process.env.AGENTDECK_KIT_VARIANT ?? '').trim() === 'local',
    bgParam: backgroundParam(input),
    timeoutParam: hasShellTimeout(input),
  });
  if (text) {
    let repeated = false;
    try {
      const events = toolEvents(readTail(ownTranscript(input)));
      repeated = wasJustRefused(events, tool, (o) => String(o?.command ?? '') === command);
    } catch {
      /* judge alone */
    }
    if (!repeated) {
      saveStore(store, file);
      return deny(text);
    }
  }
  if (!background && input.tool_use_id) store.pending[input.tool_use_id] = { key, t: Date.now() };
  saveStore(store, file);
  return null;
}

/** PostToolUse / PostToolUseFailure half: close the start stamp. Silent. */
export function cmdDurationPost(input, file = FILE) {
  const tool = input?.tool_name;
  if (tool !== 'Bash' && tool !== 'PowerShell') return null;
  const id = input?.tool_use_id;
  if (!id) return null;
  const store = loadStore(file);
  const p = store.pending[id];
  if (!p) return null;
  delete store.pending[id];
  const seconds = (Date.now() - p.t) / 1000;
  const out = JSON.stringify([input.tool_response ?? '', input.error ?? '']);
  addRun(store, p.key, seconds, seconds > 100 && /timed out|Command timed out/i.test(out));
  saveStore(store, file);
  return null;
}
