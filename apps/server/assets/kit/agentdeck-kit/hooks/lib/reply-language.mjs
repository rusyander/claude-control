// Stop module: the user-facing summary is written in the USER'S language. Everything agent↔agent is
// English; the last thing the user reads is not — no reminder from the user should ever be needed.
//
// Which language the user speaks is read from what they typed this turn: a prompt written mostly in
// Cyrillic means the summary owes Cyrillic prose. A Latin-script prompt is left alone (English,
// German and Spanish all look alike to a script count, and guessing wrong costs a whole turn).
//
// Deliberately conservative: it fires only when the final message has essentially NO prose in the
// user's script while carrying a real amount of Latin prose. Code fences, inline code, links, paths
// and identifiers are stripped before counting. Kill-switch: AGENTDECK_KIT_REPLY_LANG=0.
// Contract: (input) → { decision:'block', reason } | null.
import { openSync, readSync, fstatSync, closeSync } from 'node:fs';
import { currentUserPrompt, readTail, sinceLastCompact } from './transcript.mjs';

const TAIL_BYTES = 256 * 1024; // transcripts reach tens of MB — never read one whole
const MIN_LAT_WORDS = 15; // below this there is no real prose to judge
const MIN_NATIVE_WORDS = 5; // this much prose in the user's script = the summary is theirs, pass
const CYR = /[\u0400-\u04FF]/;
const CYR_G = /[\u0400-\u04FF]/g;

export function lastAssistantText(transcript) {
  let tail;
  try {
    const fd = openSync(transcript, 'r');
    const size = fstatSync(fd).size;
    const start = Math.max(0, size - TAIL_BYTES);
    const buf = Buffer.alloc(Math.min(size, TAIL_BYTES));
    readSync(fd, buf, 0, buf.length, start);
    closeSync(fd);
    tail = buf.toString('utf8');
  } catch {
    return '';
  }
  const lines = tail.split('\n').filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) {
    let rec;
    try {
      rec = JSON.parse(lines[i]);
    } catch {
      continue; // first line of the tail is usually truncated
    }
    if (rec?.type === 'user') return ''; // reached the previous turn without finding assistant text
    if (rec?.type !== 'assistant') continue;
    const content = rec?.message?.content;
    const parts = Array.isArray(content) ? content : [];
    const t = parts
      .filter((c) => c?.type === 'text' && typeof c.text === 'string')
      .map((c) => c.text)
      .join('\n')
      .trim();
    if (t) return t;
  }
  return '';
}

/** Prose words of a message, with code, links, paths and identifiers stripped. */
function proseWords(text) {
  const prose = String(text ?? '')
    .replace(/```[\s\S]*?```/g, ' ') // fenced code
    .replace(/`[^`]*`/g, ' ') // inline code
    .replace(/\[[^\]]*\]\([^)]*\)/g, ' ') // markdown links (label is usually a path)
    .replace(/https?:\/\/\S+/g, ' ') // bare urls
    .replace(/[A-Za-z0-9_.\-/\\]*[\\/][A-Za-z0-9_.\-/\\]*/g, ' ') // paths
    .replace(/\b[A-Za-z0-9]+[-_.][A-Za-z0-9-_.]+\b/g, ' ') // kebab/snake/dotted identifiers
    .replace(/\b[a-z]+[A-Z][A-Za-z]*\b/g, ' '); // camelCase
  return prose.match(/[A-Za-z\u0400-\u04FF]{3,}/g) ?? [];
}

/** The user writes in Cyrillic: most letters of their prompt are Cyrillic. */
export function userWritesCyrillic(prompt) {
  const text = String(prompt ?? '');
  const cyr = (text.match(CYR_G) ?? []).length;
  const lat = (text.match(/[A-Za-z]/g) ?? []).length;
  return cyr >= 8 && cyr > lat;
}

/** The message is Latin-only prose: enough Latin words, next to none in Cyrillic. */
export function isLatinOnly(text) {
  const words = proseWords(text);
  const native = words.filter((w) => CYR.test(w)).length;
  return words.length - native >= MIN_LAT_WORDS && native < MIN_NATIVE_WORDS;
}

export default function replyLanguage(input) {
  if (process.env.AGENTDECK_KIT_REPLY_LANG === '0' || process.env.CLAUDE_REPLY_LANG === '0')
    return null;
  if (input?.stop_hook_active) return null; // re-entry after our own block — never loop
  const transcript = String(input?.transcript_path ?? '');
  if (!transcript) return null;
  const prompt = currentUserPrompt(input, sinceLastCompact(readTail(transcript)));
  if (!userWritesCyrillic(prompt)) return null;
  const text = lastAssistantText(transcript);
  if (!text || !isLatinOnly(text)) return null;
  return {
    decision: 'block',
    reason:
      'reply-language: your final message is in English, but the user writes in another language. Everything the USER ' +
      'reads is in their language — agent-facing text stays English, this summary does not. Rewrite it now: a short ' +
      "summary in the user's language — what was done, key numbers, what is left. Do NOT redo any work and do not " +
      're-run tools. Identifiers, paths and commands stay as they are.',
  };
}
