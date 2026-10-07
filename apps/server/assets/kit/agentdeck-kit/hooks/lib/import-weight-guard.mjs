// PreToolUse (Write|Edit): a memory entry point may not gain a heavy `@`-import.
//
// A line-initial `@path` inside CLAUDE.md / AGENTS.md is not a link — the loader pulls the whole
// target into the session prefix, where it is re-billed on every turn. Measured damage from one
// such line: a 2.5 KB CLAUDE.md importing a 40 KB doc cost 13.9k tokens per turn, and the loader
// re-injected it up to 18× in a single session (~150k tokens). Nothing in the writing moment
// hints at that price, which is exactly why it needs a machine check rather than a rule.
//
// DELIBERATELY NARROW — five conditions must all hold, anything else is allowed:
//   1. the file is a memory entry point (CLAUDE.md / CLAUDE.local.md / AGENTS.md);
//   2. the written text adds a line-initial `@path`;
//   3. that import is NEW — one already on disk never blocks an unrelated edit of the same file,
//      so someone else's convention (and my own past decisions) stay editable;
//   4. the target actually resolves to a file — `@Component`, `@scope/pkg`, an email never do;
//   5. it is over LIMIT.
// Escape hatch: repeating the identical call goes through (same contract as every context guard),
// so this can never hard-block real work — it costs one denial, once.
// Kill-switch: AGENTDECK_KIT_IMPORT_WEIGHT=0 (CLAUDE_IMPORT_WEIGHT=0 honoured).
import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { readTail, sinceLastCompact, toolEvents, wasJustRefused } from './transcript.mjs';

const LIMIT = 8 * 1024; // ≈2k tokens per turn — the point where a link beats an import
const ENTRY = /^(CLAUDE|CLAUDE\.local|AGENTS)\.md$/i;
const IMPORT_LINE = /^@([^\s`]+)/gm;

export default function importWeightGuard(input) {
  if (process.env.AGENTDECK_KIT_IMPORT_WEIGHT === '0' || process.env.CLAUDE_IMPORT_WEIGHT === '0')
    return null;

  const ti = input?.tool_input ?? {};
  const filePath = String(ti.file_path ?? '');
  const name = filePath.split(/[\\/]/).pop() ?? '';
  if (!ENTRY.test(name)) return null;

  const written = String(ti.content ?? ti.new_string ?? '');
  if (!written.includes('@')) return null;

  let onDisk = '';
  try {
    onDisk = readFileSync(filePath, 'utf8');
  } catch {
    /* brand-new entry point — every import in it is new */
  }

  const heavy = [];
  for (const m of written.matchAll(IMPORT_LINE)) {
    const spec = m[1];
    if (new RegExp(`^@${escapeRe(spec)}(\\s|$)`, 'm').test(onDisk)) continue; // already there
    let size;
    try {
      size = statSync(join(filePath, '..', spec)).size;
    } catch {
      continue; // does not resolve to a file → not an import the loader will follow
    }
    if (size > LIMIT) heavy.push({ spec, kb: Math.round(size / 1024), tok: Math.round(size / 4) });
  }
  if (!heavy.length) return null;

  // Repeat of the identical call = "I really do mean it" → let it through.
  try {
    const events = toolEvents(sinceLastCompact(readTail(input?.transcript_path)));
    const tool = String(input?.tool_name ?? '');
    const same = (prev) =>
      String(prev?.file_path ?? '') === filePath &&
      String(prev?.content ?? prev?.new_string ?? '') === written;
    if (wasJustRefused(events, tool, same)) return null;
  } catch {
    /* transcript unreadable → fall through to the denial, which is still escapable by repeating */
  }

  const w = heavy[0];
  return {
    decision: 'deny',
    reason:
      `[import-weight] ${name} would gain @${w.spec} — ${w.kb} KB ≈ ${w.tok} tok pulled into the session prefix and ` +
      `re-billed on EVERY turn (an earlier one of these cost ~150k tokens in a single session). ` +
      `Write a plain link instead and Read the file when the task actually needs it; if it must be auto-loaded, ` +
      `split out the part that is genuinely always relevant (<8 KB) and import only that. ` +
      `Deliberate and unavoidable → repeat this exact call and it goes through.`,
  };
}

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
