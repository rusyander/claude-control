// PreToolUse(Read): global document-size guard.
// Denies reading big TEXT files WHOLE — one such Read sits in the context until the session ends
// and is re-sent on every later turn. Chunked reads (offset/limit) are the right way and pass.
// Images/PDF/binaries are exempt, else the before/after screenshot flow breaks.
//
// Runs as the FIRST context-group module of pre-tool-dispatch: it decides from one statSync, while every
// other module in that dispatcher parses the transcript first. Denying here skips that work.
// Kill-switch: AGENTDECK_KIT_DOC_SIZE=0 (CLAUDE_DOC_SIZE=0 honoured).
import { statSync } from 'node:fs';

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
      `offset/limit around the hit. Splitting/compression rules: skill doc-hygiene.`,
  };
}
