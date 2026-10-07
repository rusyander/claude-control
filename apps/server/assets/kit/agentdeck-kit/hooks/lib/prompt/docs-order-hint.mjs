// Module of the prompt dispatcher (one node start per prompt for every hint). Contract:
// (input, prompt) → string | null.
// Cross-hook (UserPromptSubmit): "put the documentation in order" (English or Russian) and its variants → route the
// model into the docs-triage skill (agent half + human half, strict), instead of ad-hoc tidying.
// Kill switch: AGENTDECK_KIT_DOC_TRIAGE_HINT=0 (CLAUDE_DOC_TRIAGE_HINT=0 honoured).

export default function docsOrderHint(input, prompt) {
  if (
    process.env.AGENTDECK_KIT_DOC_TRIAGE_HINT === '0' ||
    process.env.CLAUDE_DOC_TRIAGE_HINT === '0'
  )
    return null;
  if (!prompt) return null;

  // A doc noun AND a tidy-verb must both be present — "write the documentation" alone is authoring,
  // not triage, and must not be hijacked.
  // \b is ASCII-only in JS, so Cyrillic words need explicit lookarounds — otherwise the short word
  // for "docs" never matches and "docker" / "report" (same stem) would.
  const DOCS =
    /(?<![а-яёa-z])(документ[а-яё]*|док(?:и|ов|ам|ами|ах|у|а|е)?|docs?|documentation|markdown)(?![а-яё])|\.md(?![a-z])/i;
  const TIDY =
    /(в\s+порядок|порядок\s+в|наведи\s+порядок|приберись|прибери|разложи|разбери|расклад|почист|очист|подчист|прочист|сгруппируй|сгруппир|структурир|упорядоч|систематизир|дедуплиц|убери\s+дубл|сожми|сжать|уплотн|привед\w*\s+в\s+порядок|tidy|clean\s*up|reorganiz|reorganis|consolidat|dedupe|deduplicat|sort\s+out|straighten\s+out|declutter)/i;

  if (!(DOCS.test(prompt) && TIDY.test(prompt))) return null;
  return (
    'The user asked to put documentation in order. Run the skill `agentdeck-kit:docs-triage` — the combined ' +
    'pass, both halves, STRICT mode, not an ad-hoc cleanup: ' +
    '(1) inventory every .md in the repo from metadata only (name, mtime, git, `Grep "^#"`) — ' +
    'never read a giant file whole; ' +
    '(2) classify each as agent-facing / human-facing / data; ' +
    '(3) place and rename: agent docs → the single repo `.agent/` as `<name>.agent.md` ' +
    '(CLAUDE.md, SKILL.md, PROGRESS.md, notes.md, ARCHIVE.md, README.md, TASKS.md keep their ' +
    'exact names), human docs → one `docs/` tree, no suffix; ' +
    '(4) clean what stays: dedupe, drop outdated sections and water, English for agent docs; ' +
    '(5) delete what is needed nowhere — including under archive/ and .trash/ — after verifying ' +
    'each candidate, not by pattern; the dead threshold is 14 days; ' +
    '(6) `node <kit>/tools/docs-validate.mjs` must exit 0; ' +
    "(7) report in the user's language: moved / renamed / merged / deleted / left, with the reason. " +
    'Consent gate still applies: a project whose doc policy is off, or a hands-off project, is ' +
    'reported and left untouched.'
  );
}
