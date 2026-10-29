// PostToolUse(Bash): an output too large to show inline gets a hint that only its preview was seen.
//
// Past BASH_MAX_OUTPUT_LENGTH (the panel sets it low, `bashOutputMaxChars`) Claude Code saves the whole output to
// `tool-results/<id>.txt` and shows the model a ~2 KB preview; the hook input names that file in
// `tool_response.persistedOutputPath` and its size in `persistedOutputSize`. Live 27.10 (g1 #176): a 9.6 KB diff of
// overlapping files came back as a 2 KB preview, and the group called the overlaps «plain additive» while the unseen
// part replaced a paragraph. The CLI's own «Preview (first 2KB)» line did not stop it; the hint names the rule.
//
// A hint, never a refusal: the call already ran. Another CLI's response has no such field and gets nothing.

const KB = 1024;

/** The persisted file and its size, or null when the whole output was shown inline. */
export function persisted(input) {
  const r = input?.tool_response;
  if (!r || typeof r !== 'object') return null;
  const file = typeof r.persistedOutputPath === 'string' ? r.persistedOutputPath.trim() : '';
  if (!file) return null;
  const size = Number(r.persistedOutputSize);
  return { file, size: Number.isFinite(size) && size > 0 ? size : null };
}

export function hintFor({ file, size }) {
  const whole =
    size === null ? 'the whole output' : `the whole ${Math.round((size / KB) * 10) / 10} KB`;
  return (
    `persisted-output: you saw only a ~2 KB preview; ${whole} is in ${file}. Judge nothing from the unseen part ` +
    '(a diff, a list, a count, a verdict): Read that file with offset/limit or grep it for what you are judging ' +
    'first. Next time narrow the command (grep -n, --stat, a slice) so its output fits inline.'
  );
}

export default function persistedOutputHint(input) {
  const hit = persisted(input);
  return hit ? hintFor(hit) : null;
}
