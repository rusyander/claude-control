// PreToolUse (Write|Edit): agent docs must be English (kit language rule).
// Blocking on purpose: a PostToolUse version let the non-English file land on disk and then
// asked for a rewrite — two writes, two token bills. Denying before the write costs one retry.
// Escape hatch: a `<!-- lang:xx -->` marker (any language code) in the content means "deliberate, allow".
// Measured on Cyrillic (the share of Cyrillic letters); other scripts are not judged.
// Kill-switch: AGENTDECK_KIT_LANG_GUARD=0 (CLAUDE_LANG_GUARD=0 honoured).
import { readFileSync } from 'node:fs';
import { isAgentDoc, cyrillicShare } from './agent-doc.mjs';
import { hygieneDisabled } from './doc-policy.mjs';

const MIN_LETTERS = 100; // below this, a diff is too small to judge
const MAX_CYR_SHARE = 0.3; // quoted UI strings stay well under; Cyrillic prose blows past
const LANG_MARK = /<!-- lang:[a-z-]+ -->/;
// A fenced ```agentdeck:<kind> block (sieve answers, delivery payloads) is machine data: tools parse it,
// the panel strips it from the feed, nobody reloads it. Its string values are evidence, not prose.
// An unterminated fence runs to the end of the text (a payload cut mid-write is still a payload).
const MACHINE_FENCE =
  /^[ \t]*(`{3,}|~{3,})agentdeck:[^\n]*\n[\s\S]*?(?:^[ \t]*\1[ \t]*$|(?![\s\S]))/gm;

/** A one-shot working file under .agent/tmp/ — the only place a machine payload is exempt. */
const isTmpPayloadDir = (filePath) => /\/\.agent\/tmp\//i.test(filePath.replace(/\\/g, '/'));

/** The text the language rule judges: in .agent/tmp files, without machine fences. */
const judged = (text, tmp) => (tmp ? text.replace(MACHINE_FENCE, '\n') : text);

/** True when `fragment` sits wholly inside one machine fence of `text` (an Edit of payload data). */
function insideMachineFence(text, fragment) {
  const at = fragment ? text.indexOf(fragment) : -1;
  if (at < 0) return false;
  for (const m of text.matchAll(MACHINE_FENCE)) {
    if (at >= m.index && at + fragment.length <= m.index + m[0].length) return true;
  }
  return false;
}

export default function languageGuard(input) {
  if (process.env.AGENTDECK_KIT_LANG_GUARD === '0' || process.env.CLAUDE_LANG_GUARD === '0')
    return null;

  const ti = input?.tool_input ?? {};
  const filePath = String(ti.file_path ?? '');
  if (!isAgentDoc(filePath)) return null;
  if (hygieneDisabled(filePath)) return null; // user said hands off this project

  const written = String(ti.content ?? ti.new_string ?? '');
  if (!written) return null;
  if (LANG_MARK.test(written)) return null;

  const tmp = isTmpPayloadDir(filePath);
  const { total, share } = cyrillicShare(judged(written, tmp));
  if (total < MIN_LETTERS || share <= MAX_CYR_SHARE) return null;

  const name = filePath.split(/[\\/]/).pop();
  const onDisk = readIfExists(filePath);

  // The marker lives in the FILE, but an Edit only ever carries a fragment — checking `written`
  // alone would re-block every subsequent edit of a file the user already marked as deliberate.
  if (onDisk !== null && LANG_MARK.test(onDisk)) return null;

  // An Edit's fragment carries no fence of its own: what it replaces decides whether it is payload data.
  if (
    tmp &&
    onDisk !== null &&
    ti.content == null &&
    insideMachineFence(onDisk, String(ti.old_string ?? ''))
  )
    return null;

  // The file was ALREADY in another language before this write: it is someone else's doc, or a project
  // convention we did not set. Some projects forbid touching their SKILL.md/CLAUDE.md at all.
  // Converting it is the user's call, not ours — ask instead of forcing a rewrite.
  if (onDisk !== null && isRussianProse(judged(onDisk, tmp))) {
    return {
      decision: 'ask',
      reason:
        `${name} already exists in this project in a non-English language. The kit rule "agent docs are English" ` +
        `asks for a rewrite, but some projects forbid touching such files. Allow this write as is (the file stays ` +
        `in its language)? Decline and the content is translated to English. To allow the language here for good, ` +
        `add a <!-- lang:xx --> marker (e.g. <!-- lang:ru -->) to the file.`,
    };
  }
  // A .agent/tmp file is read once, not reloaded — the reason says what is true for it.
  const cost = tmp
    ? `Cyrillic prose costs ~2x the tokens on every read (machine data inside \`\`\`agentdeck:* fences is not counted)`
    : `Cyrillic prose costs ~2x the tokens and this file reloads every session`;
  return {
    decision: 'deny',
    reason:
      `language-guard: ${name} — ${Math.round(share * 100)}% of letters are Cyrillic in an AGENT-facing doc. ` +
      `Agent docs are English (kit language rule): ${cost}. Rewrite this content in English NOW and retry the write — telegraphic, one fact ` +
      `per line. Keep quoted UI strings / user quotes in their language as data. Your summary TO THE USER stays in the ` +
      `user's language. If the file is non-English by design (human-facing), put it outside agent scope or add <!-- lang:xx -->.`,
  };
}

/** Current content, or null when the file does not exist yet (a brand-new doc). */
function readIfExists(filePath) {
  try {
    return readFileSync(filePath, 'utf8');
  } catch {
    return null;
  }
}

function isRussianProse(text) {
  const { total, share } = cyrillicShare(text);
  return total >= MIN_LETTERS && share > MAX_CYR_SHARE;
}
