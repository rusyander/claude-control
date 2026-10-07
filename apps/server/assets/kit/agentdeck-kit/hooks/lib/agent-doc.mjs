// Shared classifier: is this .md file agent-facing (English, compressed) or human-facing?
// Used by language-guard (PreToolUse deny) and doc-bloat-guard / doc-daily-review.
// One definition, one place — the old per-hook copies drifted and left CLAUDE.md unguarded.
import { resolve, sep } from 'node:path';

/** Normalize any path to forward slashes, absolute. */
export function norm(filePath) {
  return resolve(filePath).split(sep).join('/');
}

// Human-facing by design — never flagged for language, never size-nagged as an agent doc.
const HUMAN = [
  /\/TASKS\.md$/i,
  /\/README(\.[a-z-]+)?\.md$/i,
  /\/SETUP(\.[a-z-]+)?\.md$/i,
  /\/CHANGELOG(\.[a-z-]+)?\.md$/i,
  /\/CONTRIBUTING(\.[a-z-]+)?\.md$/i,
  /\/ONBOARDING(\.[a-z-]+)?\.md$/i,
  /\/LICENSE(\.md)?$/i,
  /\/docs?\//i,
];

// Agent-facing scopes. CLAUDE.md / AGENTS.md are agent docs wherever they sit — that is their
// entire purpose (auto-loaded into the model's context, never read by a human).
// `docs/ai|agent|claude/` is named unambiguously enough to classify without reading the file;
// without it everything under docs/ counted as human and escaped both language and layout rules.
const AGENT = [
  /\/docs?\/(ai|agent|agents|claude)\//i,
  /\/\.agent\//,
  /\/CLAUDE\.md$/i,
  /\/CLAUDE\.local\.md$/i,
  /\/AGENTS\.md$/i,
  /\/\.claude\/projects\/[^/]+\/memory\//,
  /\/\.claude\/project-profile\.md$/i,
  /\/\.claude\/agents\/[^/]+\.md$/i,
  /\/\.claude\/commands\/.+\.md$/i,
  /\/\.claude\/skills\/.+\.md$/i,
  /\/\.claude\/rules\/.+\.md$/i,
];

/** True when the model — not a person — is the reader of this file. */
export function isAgentDoc(filePath) {
  if (!filePath || !/\.md$/i.test(filePath)) return false;
  const p = norm(filePath);
  // A named agent directory wins over the generic docs/ exemption: docs/ai/plan.md is an agent
  // doc that merely happens to sit under docs/.
  if (/\/docs?\/(ai|agent|agents|claude)\//i.test(p)) return true;
  // The `.agent.md` suffix is our own audience marker, so it classifies WHEREVER the file sits —
  // and it must be checked before location, or the classifier only recognises agent docs that are
  // already in the right place. That blinded the layout guard to the exact case it exists for: a
  // note dropped next to the code it describes (src/components/notes.agent.md) counted as human,
  // escaping the language, layout and size guards at once.
  if (/\.agent\.md$/i.test(p)) return true;
  if (HUMAN.some((re) => re.test(p))) return false;
  return AGENT.some((re) => re.test(p));
}

/**
 * Cyrillic share among letters — the measure of Russian PROSE in an agent doc.
 * Russian inside «guillemets» or `backticks` is DATA, not prose: trigger phrases a skill description
 * matches against the user's prompt, quoted UI strings, quoted user wording. CLAUDE.md exempts them
 * explicitly, so they are stripped before counting — otherwise a short, mostly-English skill
 * description made of trigger phrases trips the guard the rule was written to permit.
 */
export function cyrillicShare(text) {
  const prose = text.replace(/«[^»]*»/g, ' ').replace(/`[^`\n]*`/g, ' ');
  const cyr = (prose.match(/[\u0400-\u04FF]/g) ?? []).length;
  const lat = (prose.match(/[A-Za-z]/g) ?? []).length;
  const total = cyr + lat;
  return { cyr, lat, total, share: total ? cyr / total : 0 };
}
