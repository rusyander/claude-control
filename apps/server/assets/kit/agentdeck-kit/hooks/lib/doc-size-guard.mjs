// PreToolUse(Read): global document-size guard.
// Denies reading big TEXT files WHOLE — one such Read sits in the context until the session ends
// and is re-sent on every later turn. Chunked reads (offset/limit) are the right way and pass.
// Images/PDF/binaries are exempt, else the before/after screenshot flow breaks.
//
// Runs as the FIRST context-group module of pre-tool-dispatch: it decides from one statSync, while every
// other module in that dispatcher parses the transcript first. Denying here skips that work.
// Kill-switch: AGENTDECK_KIT_DOC_SIZE=0 (CLAUDE_DOC_SIZE=0 honoured).
import { readFileSync, statSync } from 'node:fs';

// Not text — size says nothing (screenshots/PDF are read differently).
const EXEMPT =
  /\.(png|jpe?g|gif|webp|bmp|ico|svg|pdf|zip|gz|tgz|tar|7z|rar|mp4|mov|mp3|wav|woff2?|ttf|otf|eot|xlsx?|docx?|pptx?|exe|dll|so|dylib|bin|lock)$/i;

const MAX_BYTES = 30 * 1024;

export default function docSizeGuard(input) {
  if (process.env.AGENTDECK_KIT_DOC_SIZE === '0' || process.env.CLAUDE_DOC_SIZE === '0')
    return null;
  if (input?.tool_name !== 'Read') return null;

  const ti = input.tool_input ?? {};
  const filePath = String(ti.file_path ?? '');
  if (!filePath) return null;

  // Already chunked — correct usage, pass.
  if (ti.offset != null || ti.limit != null) return null;
  if (EXEMPT.test(filePath)) return null;

  let size;
  try {
    size = statSync(filePath).size;
  } catch {
    return null; // missing/unreadable — let Read produce the real error
  }
  if (size <= MAX_BYTES) return null;

  const kb = Math.round(size / 1024);
  return {
    decision: 'deny',
    reason:
      `[doc-size-guard] ${kb} KB file — reading it whole is denied (it would sit in context until the ` +
      `end of the session and be re-sent on every turn). Grep for the anchor you need, then Read with ` +
      `offset/limit around the hit. Splitting/compression rules: skill doc-hygiene.` +
      windows(filePath, size),
  };
}

const WINDOW = 400;
const SHOWN = 8;
const COUNT_CAP = 64 * 1024 * 1024;

/**
 * Ready Read windows for the refusal. A persisted tool result (`tool-results/*.txt`, a whole MR diff)
 * is the file a reader most often gives up on: the refusal named no window, so the diff was
 * skimmed instead of read (MR !988). Line count = one pass over the file, skipped above 64 MB.
 */
function windows(filePath, size) {
  if (size > COUNT_CAP) return '';
  let lines;
  try {
    lines = readFileSync(filePath, 'utf8').split('\n').length;
  } catch {
    return '';
  }
  const total = Math.ceil(lines / WINDOW);
  const shown = [];
  for (let k = 0; k < Math.min(total, SHOWN); k++)
    shown.push(`offset=${k * WINDOW + 1} limit=${WINDOW}`);
  const more = total > SHOWN ? `, … ${total - SHOWN} more (${total} windows)` : '';
  const persisted = /[\\/]tool-results[\\/]/.test(filePath)
    ? ' A persisted tool result is read to the end in these windows — a diff skimmed by grep alone is not read.'
    : '';
  return ` ${lines} lines; ${WINDOW}-line windows: ${shown.join('; ')}${more}.${persisted}`;
}
