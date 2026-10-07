// Shared transcript reader for context-budget guards.
//
// Why read the transcript instead of keeping our own state files: the transcript is the
// single source of truth the model actually sees. It survives restarts, it marks compaction
// boundaries explicitly, and it can never drift from reality the way a side-car state file can.
//
// Transcripts reach 100+ MB, so we only ever read a tail slice and only parse the last N records.
import { openSync, readSync, closeSync, statSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { STATE_DIR } from './kit-paths.mjs';

const TAIL_BYTES = 3 * 1024 * 1024;
const MAX_RECORDS = 400;

/** Parse the tail of a .jsonl transcript. Returns records oldest→newest; [] on any problem. */
export function readTail(transcriptPath, tailBytes = TAIL_BYTES, maxRecords = MAX_RECORDS) {
  if (!transcriptPath) return [];
  let fd;
  try {
    const size = statSync(transcriptPath).size;
    const start = Math.max(0, size - tailBytes);
    const len = size - start;
    if (len <= 0) return [];
    const buf = Buffer.alloc(len);
    fd = openSync(transcriptPath, 'r');
    readSync(fd, buf, 0, len, start);
    const text = buf.toString('utf8');
    // A non-zero start almost certainly lands mid-record; drop the first partial line.
    const lines = text.split('\n');
    if (start > 0) lines.shift();
    const out = [];
    for (let i = lines.length - 1; i >= 0 && out.length < maxRecords; i--) {
      const line = lines[i];
      if (!line || line.charCodeAt(0) !== 123 /* { */) continue;
      try {
        out.push(JSON.parse(line));
      } catch {
        /* truncated or corrupt line — skip */
      }
    }
    return out.reverse();
  } catch {
    return [];
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        /* ignore */
      }
    }
  }
}

/**
 * Everything after the last compaction boundary.
 * After a compact the model genuinely lost the detail, so re-reading a file or re-running a
 * check is legitimate again — guards must not punish it for that.
 */
export function sinceLastCompact(records) {
  for (let i = records.length - 1; i >= 0; i--) {
    const r = records[i];
    if (r.type === 'system' && r.subtype === 'compact_boundary') return records.slice(i + 1);
  }
  return records;
}

/** Flatten to a chronological list of {kind:'use'|'result', ...} entries. */
export function toolEvents(records) {
  const events = [];
  for (const r of records) {
    const content = r.message?.content;
    if (!Array.isArray(content)) continue;
    const ts = r.timestamp ? Date.parse(r.timestamp) : null;
    for (const c of content) {
      if (!c || typeof c !== 'object') continue;
      if (c.type === 'tool_use') {
        events.push({ kind: 'use', id: c.id, name: c.name, input: c.input || {}, ts });
      } else if (c.type === 'tool_result') {
        const body =
          typeof c.content === 'string'
            ? c.content
            : Array.isArray(c.content)
              ? c.content.map((x) => (typeof x?.text === 'string' ? x.text : '')).join('\n')
              : '';
        events.push({ kind: 'result', id: c.tool_use_id, isError: Boolean(c.is_error), body, ts });
      }
    }
  }
  return events;
}

/** Result body for a given tool_use id, or null when the call has no result yet. */
export function resultFor(events, id) {
  for (const e of events) if (e.kind === 'result' && e.id === id) return e;
  return null;
}

/**
 * The most recent thing the USER actually typed — not tool results, not harness text.
 * Every guard uses this to honour an explicit override ("re-read it", "run the tests"), so a
 * false positive here silently switches a guard off for the rest of the session. Two sources of
 * false positives are excluded: post-compaction continuation prompts (they embed a summary of
 * the whole prior conversation, in which any phrase can occur) and <system-reminder> blocks.
 */
export function lastUserPrompt(records) {
  return lastUserSpeech(records).text;
}

/**
 * Same, but with the record index — `{index, text}`, index -1 when the user never spoke.
 * The position is what the consent gate runs on: "did the user type anything AFTER we refused
 * this?" is the one signal that cannot be manufactured from inside an assistant turn, because no
 * user record can appear until the turn ends.
 */
export function lastUserSpeech(records) {
  for (let i = records.length - 1; i >= 0; i--) {
    const text = typedText(records[i]);
    if (text) return { index: i, text };
  }
  return { index: -1, text: '' };
}

/**
 * Everything the user typed in this window, oldest→newest, filtered exactly like `lastUserSpeech`.
 * A standing authorisation ("this ticket, take it") is given ONCE and then has to hold across the
 * dozens of tool calls that follow, so a guard honouring it cannot look at the newest message only.
 */
export function userSpeech(records) {
  const out = [];
  for (let i = 0; i < records.length; i++) {
    const text = typedText(records[i]);
    if (text) out.push({ index: i, text });
  }
  return out;
}

/** The text a record carries when it is the user speaking, '' otherwise. */
function typedText(r) {
  // NB: promptId is present on EVERY user record, tool results included — it does not mark a
  // typed message. isCompactSummary is the reliable flag for harness-generated text.
  if (r?.type !== 'user' || r.isCompactSummary) return '';
  const c = r.message?.content;
  let text = '';
  if (typeof c === 'string') text = c;
  else if (Array.isArray(c)) {
    text = c
      .filter((x) => x && x.type === 'text' && typeof x.text === 'string')
      .map((x) => x.text)
      .join('\n');
  }
  if (!text || isSyntheticPrompt(text)) return '';
  return stripReminders(text);
}

/** Marker embedded in every guard denial so a guard can recognise its own previous refusal. */
export const GUARD_MARK = '[ctx-guard]';

/**
 * Was this tool_result a hook refusal?
 * Must be a PREFIX test, never a substring search: a successful Read of a file that merely
 * MENTIONS the marker (this very file does) would otherwise be misread as a refusal, and the
 * guard would silently stop counting that file as "already read".
 */
export function isRefusal(body) {
  const head = String(body || '').trimStart();
  return head.startsWith(GUARD_MARK) || head.startsWith('[doc-size-guard]');
}

/**
 * The continuation prompt injected after a compaction is NOT the user speaking — it embeds a
 * summary of the whole prior conversation, so any phrase can appear in it by accident. Treating
 * it as a user instruction let a summary containing "re-read" disable the read guard for the
 * rest of the session. Same for <system-reminder> blocks, which are harness text, and for
 * background-task notifications, which arrive as user-role turns and can carry ANY phrase
 * (live 2026-08-04: a subagent report inside one re-triggered the docs-triage hint).
 */
// Also harness-written, all found as "user speech" in the 23.09.2026 replay of retained denials: a
// Stop hook's block reason, a message relayed from another session, the interrupt marker, local
// command output. Counted as the user replying, any of them re-opened the consent gate's door B.
const HARNESS_TURN =
  /^\s*(?:Stop hook feedback:|Another Claude session sent a message:|\[Request interrupted by user|<local-command-(?:caveat|stdout|stderr)>)/i;

export function isSyntheticPrompt(text) {
  const t = String(text || '');
  return (
    /This session is being continued from a previous conversation/i.test(t) ||
    /^\s*\[SYSTEM NOTIFICATION\b/i.test(t) ||
    t.includes('<task-notification>') ||
    HARNESS_TURN.test(t)
  );
}

export function stripReminders(text) {
  return String(text || '').replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, ' ');
}

/**
 * Is this hook firing inside a subagent? The harness stamps `agent_id` on hook input only there
 * (its schema: "Present only when the hook fires from within a subagent") and hands the PARENT's
 * transcript_path along with it. Every history-based context guard has to know: judged against the
 * parent's history, a subagent's FIRST read of a file looks like a re-read, and the repeat escape
 * never opens because the parent's last call is never the child's. Measured 18.09.2026 over 129
 * subagent transcripts: 40 read-discipline refusals, 0 of them genuine — the child was locked out of
 * the file for the rest of its run. The `/subagents/` path test stays for a build that passes the
 * child's own transcript instead.
 */
export function inSubagent(input) {
  return (
    Boolean(input?.agent_id) || /[\\/]subagents[\\/]/.test(String(input?.transcript_path ?? ''))
  );
}

/**
 * What the user typed THIS turn.
 * Prefers the file written by `record-prompt` (UserPromptSubmit) because the transcript tail is
 * bounded: in a long turn the user's own message scrolls out of the parsed window and every
 * "the user asked for it" override silently dies. Falls back to the transcript when the file is
 * absent (hook not registered yet, first turn after an upgrade) so nothing depends on it.
 */
export function currentUserPrompt(input, records) {
  const session = String(input?.session_id ?? '').replace(/[^a-zA-Z0-9-]/g, '');
  if (session) {
    try {
      const body = readFileSync(join(STATE_DIR, 'prompts', `${session}.json`), 'utf8');
      const saved = JSON.parse(body);
      if (saved && typeof saved.prompt === 'string' && saved.prompt)
        return stripReminders(saved.prompt);
    } catch {
      /* fall through to the transcript */
    }
  }
  return lastUserPrompt(records || []);
}

/**
 * Escape hatch: the most recent IDENTICAL call of this tool was refused by us. Repeating a call is
 * the model's way of saying "I really do need this" — always let the second attempt through, so no
 * guard can ever hard-block real work.
 * "Most recent identical", not "the very last use": parallel batches interleave — Read A (refused) ·
 * Read B · Read C · Read A again — and bailing on the first non-matching use killed the hatch the
 * moment any other call of the same tool sat in between (deferred 04.08.2026, applied 18.09.2026).
 * The window bounds the scan; a refusal older than that many uses is not "just" refused.
 * A use with no result yet is the in-flight call itself, sometimes flushed before PreToolUse runs
 * (1 of 19 repeats, 21.09.2026) — skipped, or it hides the refusal it is repeating.
 */
export function wasJustRefused(events, toolName, sameCall, window = 40) {
  let seen = 0;
  for (let i = events.length - 1; i >= 0 && seen < window; i--) {
    const e = events[i];
    if (e.kind !== 'use' || e.name !== toolName) continue;
    seen++;
    if (!sameCall(e.input)) continue;
    const res = resultFor(events.slice(i), e.id);
    if (!res) continue;
    return isRefusal(res.body);
  }
  return false;
}

export function deny(reason) {
  return { decision: 'deny', reason: `${GUARD_MARK} ${reason}` };
}
