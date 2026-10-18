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
// call into a «600 s, killed» record. Keyed by cwd + normalised command.
// Verdicts (repeat of the identical call = escape):
//   · main session, foreground, learned ≥ 300 s or killed before → run_in_background (notification wakes);
//   · any session, learned > the call's timeout (default 120 s) → raise `timeout` (cap 600000 ms);
//   · subagent, learned ≥ 540 s or killed before → narrow or split it, the foreground cap is 600 s.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';

import { dirname, join } from 'node:path';
import { backgroundParam, hasShellTimeout, stateDir } from './kit-paths.mjs';
import {
  deny,
  inSubagent,
  ownTranscript,
  readTail,
  toolEvents,
  wasJustRefused,
} from './transcript.mjs';

const FILE = join(stateDir('durations'), 'cmd-durations.json');
const CAP_S = 600;
const KEEP_KEYS = 400;
const KEEP_RUNS = 5;

export function commandKey(cwd, command) {
  const cmd = String(command)
    .replace(/\s+2>&1/g, '')
    .replace(/\s*\|\s*(tail|head)(\s+-n)?\s+-?\d+\s*$/i, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 300);
  return `${String(cwd ?? '').toLowerCase()}|${cmd}`;
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
  // A split group or a local-model run stays in the foreground (gate-at-end allows it there): the
  // panel reads the end of a group's turn as its result, and local-discipline refuses background.
  // A CLI whose shell has no background flag (bgParam null) cannot obey the advice at all.
  if (!subagent && slow && !foregroundOnly && bgParam)
    return (
      `cmd-duration: this command took ~${known.median} s here (${known.n} run(s)` +
      `${known.kills ? `, ${known.kills} killed at the ${CAP_S} s cap` : ''}). Run it with ${bgParam}: true — ` +
      'its completion notification wakes you — and do other work meanwhile, or narrow it. Repeat this exact call ' +
      'to run it in the foreground anyway.'
    );
  if (subagent && (known.median >= 540 || known.kills > 0))
    return (
      `cmd-duration: this command took ~${known.median} s here` +
      `${known.kills ? ` and was killed at the ${CAP_S} s cap ${known.kills}×` : ''}; a subagent has no background ` +
      'wake-up and the foreground cap is 600 s. Narrow it (one file, --quick) or split it. Repeat this exact call ' +
      'to try anyway.'
    );
  const limit = (timeoutMs ?? 120_000) / 1000;
  if (timeoutParam && known.median > limit * 0.9)
    return (
      `cmd-duration: this command took ~${known.median} s here but the call's timeout is ${Math.round(limit)} s ` +
      `(default 120 s) — it would be killed and re-run. Pass timeout: ` +
      `${Math.min(600_000, Math.ceil(known.median * 1.5) * 1000)}. Repeat this exact call to keep the timeout.`
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
    known: learned(store.keys[key]),
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
