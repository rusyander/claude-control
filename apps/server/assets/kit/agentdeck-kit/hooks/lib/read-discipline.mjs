// PreToolUse(Read, Bash): keep re-reads out of the context window.
//
// Measured on 21 days of transcripts: 20% of all Read calls were the same file read again in the
// same session (50% in the longest one). The content is still in the window — re-reading pays for
// it twice and is a symptom of an overloaded session, not a need.
//
// Bash: the same re-read through `cat f`, `head -n N f`, `sed -n 'a,bp' f`, `tail f` slipped past a
// Read-only guard. Each simple command of a chain is judged (right after a compaction `grep …; cat
// PROGRESS.md` ran twice in 4 s); a pipe or redirect is real work and passes. A Bash read whose output
// the CLI persisted to a file (too large) never counts as "already in the window".
//
// Scope note: whole-file size is NOT handled here. `doc-size-guard` already denies whole reads
// above 30 KB; duplicating that check would only produce two refusals for one call.
import { statSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import {
  readTail,
  sinceLastCompact,
  toolEvents,
  resultFor,
  wasJustRefused,
  deny,
  isRefusal,
  currentUserPrompt,
  inSubagent,
} from './transcript.mjs';

// Read renders these visually or paginates them itself.
const OPAQUE = /\.(png|jpe?g|gif|webp|bmp|ico|svg|pdf|ipynb)$/i;

// An explicit "read it again" from the user outranks the guard.
// Word-bounded on purpose: a bare /again/ also matches "against", and one stray word in a long
// user message must not switch the guard off for the rest of the session.
const WANTS_REREAD = /перечитай|заново|ещё раз|еще раз|\bre-?read\b|\bagain\b/i;

// The CLI's marker for Bash output too large to inline: the content never reached the window.
const PERSISTED = /persisted-output|Output too large/;

const norm = (p) =>
  String(p || '')
    .replace(/\\/g, '/')
    .toLowerCase();

// One file operand: bare or quoted, no shell metacharacters.
const FILE = String.raw`(?:"([^"$\`\\]+)"|'([^']+)'|([^\s"'$\`\\|;&<>()*?]+))`;
const BASH_READS = [
  { re: new RegExp(String.raw`^cat\s+${FILE}$`), range: () => ({ offset: 0, limit: 0 }) },
  {
    re: new RegExp(String.raw`^head(?:\s+-n\s*(\d+)|\s+-(\d+))?\s+${FILE}$`),
    range: (m) => ({ offset: 1, limit: Number(m[1] ?? m[2] ?? 10) }),
  },
  {
    re: new RegExp(
      String.raw`^sed\s+-n\s+(?:'(\d+),(\d+)p'|"(\d+),(\d+)p"|(\d+),(\d+)p)\s+${FILE}$`,
    ),
    range: (m) => {
      const from = Number(m[1] ?? m[3] ?? m[5]);
      const to = Number(m[2] ?? m[4] ?? m[6]);
      return to >= from ? { offset: from, limit: to - from + 1 } : null;
    },
  },
  // tail's start is unknown without the line count: only a whole earlier read covers it.
  {
    re: new RegExp(String.raw`^tail(?:\s+-n\s*(\d+)|\s+-(\d+))?\s+${FILE}$`),
    range: () => ({ tail: true }),
  },
];

const absolute = (p) => isAbsolute(p) || /^[A-Za-z]:[\\/]/.test(p);

/** `{ file_path, offset, limit }` (limit 0 = whole file, `tail` = the end) of a pure Bash read, else null. */
export function bashRead(command, cwd) {
  const text = String(command ?? '').trim();
  for (const { re, range } of BASH_READS) {
    const m = re.exec(text);
    if (!m) continue;
    const [q2, q1, bare] = m.slice(-3);
    const raw = q2 ?? q1 ?? bare;
    const r = range(m);
    if (!raw || !r) return null;
    const filePath = absolute(raw) ? raw : cwd ? resolve(cwd, raw) : null;
    return filePath ? { file_path: filePath, ...r } : null;
  }
  return null;
}

/**
 * Every pure read among the simple commands of a Bash line (`grep …; cat f`, `cd d && sed -n 1,9p f`),
 * with `seg` = its own text. Split on `;` `&&` `||` `&` and newlines outside quotes; a pipe or redirect
 * keeps the segment whole (`cat f | head` filters, it is no read). `cd` moves the base of relative paths;
 * a `cd` the guard cannot resolve (a variable, `~`) stops judging relative ones. A heredoc is not split.
 */
export function bashReads(command, cwd) {
  const text = String(command ?? '');
  if (/<<(?!<)/.test(text)) return [];
  const segs = [];
  let cur = '';
  let quote = '';
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quote) {
      if (ch === quote) quote = '';
      else if (ch === '\\' && quote === '"') cur += text[i++];
      cur += ch;
      continue;
    }
    if (ch === "'" || ch === '"') quote = ch;
    else if (ch === '\\') {
      cur += ch + (text[i + 1] ?? '');
      i++;
      continue;
    } else if (
      ch === ';' ||
      ch === '\n' ||
      (ch === '&' && text[i + 1] !== '>' && text[i - 1] !== '>')
    ) {
      segs.push(cur);
      cur = '';
      if (ch === '&' && text[i + 1] === '&') i++;
      continue;
    } else if (ch === '|' && text[i + 1] === '|') {
      segs.push(cur);
      cur = '';
      i++;
      continue;
    }
    cur += ch;
  }
  segs.push(cur);
  const out = [];
  let dir = cwd ?? null;
  for (const raw of segs) {
    const seg = raw.trim();
    const cd = /^cd\s+(?:"([^"]+)"|'([^']+)'|(\S+))$/.exec(seg);
    if (cd) {
      const to = cd[1] ?? cd[2] ?? cd[3];
      // A leading `~` is the home dir, unknown here; a `~` inside is an 8.3 short name (`USER~1`).
      dir = /[$`]|^~/.test(to) ? null : absolute(to) ? to : dir ? resolve(dir, to) : null;
      continue;
    }
    const read = bashRead(seg, dir);
    if (read) out.push({ ...read, seg });
  }
  return out;
}

const fromRead = (ti) =>
  ti?.file_path ? { file_path: ti.file_path, offset: ti.offset ?? 0, limit: ti.limit ?? 0 } : null;

export default function readDiscipline(input) {
  const tool = input?.tool_name;
  if (tool !== 'Read' && tool !== 'Bash') return null;
  // A subagent is handed the PARENT's transcript: judged against it, the child's first read of a file
  // is "already read" and the repeat escape never opens (40 false refusals, 0 genuine — 18.09.2026).
  if (inSubagent(input)) return null;
  const command = String(input.tool_input?.command ?? '').trim();
  const wants = (
    tool === 'Read' ? [fromRead(input.tool_input)] : bashReads(command, input.cwd)
  ).filter((w) => w && !OPAQUE.test(w.file_path));
  // A file the tool cannot stat (missing, a directory) is left to produce its real error.
  const files = wants.flatMap((want) => {
    try {
      const stat = statSync(want.file_path);
      return stat.isFile() ? [{ want, stat }] : [];
    } catch {
      return [];
    }
  });
  if (!files.length) return null;

  const records = sinceLastCompact(readTail(input.transcript_path));
  if (records.length === 0) return null; // no history to judge against
  const events = toolEvents(records);

  const first = files[0].want;
  const sameCall =
    tool === 'Read'
      ? (other) =>
          norm(other?.file_path) === norm(first.file_path) &&
          `${other?.offset ?? 0}:${other?.limit ?? 0}` === `${first.offset}:${first.limit}`
      : (other) => String(other?.command ?? '').trim() === command;
  if (wasJustRefused(events, tool, sameCall)) return null;
  if (WANTS_REREAD.test(currentUserPrompt(input, records))) return null;

  const hits = files.flatMap(({ want, stat }) => {
    const previous = lastSuccessfulRead(events, want.file_path, input.cwd);
    // Any write to the file — by us or by anyone else — makes a re-read legitimate; a wider slice than
    // last time is new information, a narrower or identical one is not.
    if (!previous?.ts || stat.mtimeMs > previous.ts || !coveredBy(previous.range, want)) return [];
    const scope = previous.range.limit
      ? `lines ${previous.range.offset || 1}-${(previous.range.offset || 1) + previous.range.limit}`
      : 'whole file';
    return [{ want, scope }];
  });
  if (!hits.length) return null;

  const named = hits.map(({ want, scope }) => `${shortName(want.file_path)} (${scope})`).join(', ');
  const chained = tool === 'Bash' && hits.some(({ want }) => want.seg !== command);
  const again = tool === 'Read' ? 'repeat this same call' : 'repeat this same command';
  return deny(
    `${named} ${hits.length > 1 ? 'were already read this session and have' : 'was already read this session and has'} not changed since — ` +
      `the content is still in the context above, find it there. ` +
      (chained
        ? `Drop ${hits.map(({ want }) => `\`${want.seg}\``).join(', ')} from this command and run the rest. `
        : '') +
      `Need a different part: Read with another offset/limit, or Grep. Genuinely need it again — ${again}.`,
  );
}

/** True when the earlier read already covers everything the new one asks for. */
function coveredBy(prev, next) {
  if (!prev.limit && !prev.tail) return true; // previous read took the whole file
  if (next.tail || prev.tail) return false; // the end's position is unknown against a slice
  if (!next.limit) return false; // now asking for the whole file — genuinely more
  const prevStart = prev.offset || 1;
  const nextStart = next.offset || 1;
  return nextStart >= prevStart && nextStart + next.limit <= prevStart + prev.limit;
}

function shortName(p) {
  const parts = String(p).replace(/\\/g, '/').split('/');
  return parts.slice(-2).join('/');
}

/**
 * Most recent read of this path — a Read, or a Bash read (alone or in a chain) — that actually returned
 * content. A failed read (missing file, permission error, our own refusal) or a Bash output persisted to
 * a file must never count as "you already have it".
 */
function lastSuccessfulRead(events, filePath, cwd) {
  const target = norm(filePath);
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i];
    if (e.kind !== 'use') continue;
    const range =
      e.name === 'Read'
        ? fromRead(e.input)
        : e.name === 'Bash'
          ? bashReads(e.input?.command, cwd).findLast((r) => norm(r.file_path) === target)
          : null;
    if (!range || norm(range.file_path) !== target) continue;
    const res = resultFor(events.slice(i), e.id);
    if (!res || res.isError) continue;
    if (isRefusal(res.body)) continue;
    if (e.name === 'Bash' && PERSISTED.test(String(res.body ?? ''))) continue;
    return { range, ts: e.ts };
  }
  return null;
}
