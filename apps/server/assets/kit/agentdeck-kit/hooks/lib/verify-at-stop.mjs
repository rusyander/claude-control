// Stop module: a turn that EDITED CODE and never RAN A CHECK afterwards does not end silently.
// Kit rule: "the task is not done until the gate ran" — held by prose alone, that line depended on
// the user remembering to ask. This is the
// automatic half: the first Stop after such a turn is blocked once with the instruction to run the
// gate that covers the edited files (or to state in the summary that it could not run, and
// why). Never twice — `stop_hook_active` marks the re-entry and lets it through.
//
// What counts as a check: any Bash/PowerShell call AFTER the last code edit whose command runs a
// test runner, a type-checker, a linter, a build, or a node/python script that is itself a test or
// check (tests/ folder, *.test.*, check-/verify-/audit-/parity-named). A red run counts too — the
// point is that a real path executed and its output was read, not that it was green.
// What does not count: edits under .agent/, scratchpad or temp folders, node_modules, build output,
// and documents (.md, .json, .txt) — those are not code. The user can switch the gate off for one
// turn in plain words ("don't check", "no tests", "skip the tests", in English or Russian); AGENTDECK_KIT_VERIFY_AT_STOP=0 (or CLAUDE_VERIFY_AT_STOP=0) for good.
// Contract: (input) → { decision:'block', reason } | null.
import {
  readTail,
  sinceLastCompact,
  toolEvents,
  lastUserSpeech,
  currentUserPrompt,
  inSubagent,
} from './transcript.mjs';

const CODE =
  /\.(m?[jt]sx?|c[jt]s|vue|svelte|go|py|rs|java|kt|cs|rb|php|s?css|less|sql|graphql|proto|ya?ml|toml|sh|ps1)$/i;
const SKIP_PATH = /[\\/](\.agent|node_modules|dist|build|coverage|scratchpad|Temp|tmp)[\\/]/i;
const VERIFY = new RegExp(
  [
    '\\b(pytest|vitest|jest|mocha|playwright|cypress|karma|ava|tap)\\b',
    '\\bgo\\s+(test|vet|build)\\b',
    '\\bcargo\\s+(test|check|clippy|build)\\b',
    '\\b(npm|pnpm|yarn|bun)\\s+(run\\s+)?(test|lint|type-?check|typecheck|check|build|e2e|verify)\\b',
    '\\b(npx|pnpm|bunx)\\s+(tsc|eslint|vitest|jest|playwright|biome|prettier\\s+--check)\\b',
    '\\b(tsc|eslint|biome|ruff|mypy|pyright|flake8|golangci-lint|stylelint|vue-tsc|svelte-check)\\b',
    '\\bmake\\s+(test|lint|check|verify)\\b',
    '\\b(dotnet|swift|gradle|gradlew|mvn|deno)\\s+(test|build|check|lint)\\b',
    '\\b(phpunit|artisan\\s+test|rspec|rubocop|composer\\s+test)\\b',
    // a node/python script that is itself a check: under tests/, *.test.*, or check-/verify-/shot-named
    '\\bnode\\s+[^\\s|&;]*(tests?[\\\\/]|\\.test\\.[cm]?[jt]s|(check|verif|parity|audit|scan|mustfail|smoke|probe|shots?|e2e)[^\\s|&;]*\\.[cm]?[jt]s)',
    '\\bpython3?\\s+(-m\\s+)?[^\\s|&;]*(test|check|verif|smoke)',
    // a live probe against a stand counts: the rule asks for one live positive and one negative
    '\\b(curl|http|httpie|Invoke-WebRequest|Invoke-RestMethod|iwr|irm)\\b',
  ].join('|'),
  'i',
);
const OPT_OUT =
  /(?<![а-яё])(не\s+(нужно\s+|надо\s+)?(проверя|запуска|прогоня|тестир)|без\s+(проверк|тестов|прогон))|\b(no|skip|without)\s+(the\s+)?(tests?|checks?|verification)\b/i;
const EDIT_TOOL = /^(Write|Edit|MultiEdit|NotebookEdit)$/;

export function editedCodeWithoutCheck(records) {
  const { index } = lastUserSpeech(records);
  const events = toolEvents(records.slice(index + 1)); // index -1 → the whole tail is the turn
  const edits = [];
  let lastEdit = -1;
  events.forEach((e, i) => {
    if (e.kind !== 'use' || !EDIT_TOOL.test(String(e.name ?? ''))) return;
    const p = String(e.input?.file_path ?? e.input?.notebook_path ?? '');
    if (!CODE.test(p) || SKIP_PATH.test(p)) return;
    edits.push(p);
    lastEdit = i;
  });
  if (!edits.length) return null;
  const checked = events
    .slice(lastEdit + 1)
    .some(
      (e) =>
        e.kind === 'use' &&
        /^(Bash|PowerShell)$/.test(String(e.name ?? '')) &&
        VERIFY.test(String(e.input?.command ?? '')),
    );
  return checked ? null : edits;
}

export default function verifyAtStop(input) {
  if (process.env.AGENTDECK_KIT_VERIFY_AT_STOP === '0' || process.env.CLAUDE_VERIFY_AT_STOP === '0')
    return null;
  if (input?.stop_hook_active) return null;
  if (inSubagent(input)) return null;
  let records;
  try {
    records = sinceLastCompact(readTail(String(input?.transcript_path ?? '')));
  } catch {
    return null;
  }
  if (!records?.length) return null;
  const edits = editedCodeWithoutCheck(records);
  if (!edits) return null;
  let prompt = '';
  try {
    prompt = String(currentUserPrompt(input, records) ?? '');
  } catch {
    /* no prompt store → no opt-out */
  }
  if (OPT_OUT.test(prompt)) return null;
  const names = [...new Set(edits.map((p) => p.split(/[\\/]/).pop()))];
  const shown = names.slice(0, 4).join(', ') + (names.length > 4 ? `, +${names.length - 4}` : '');
  return {
    decision: 'block',
    reason:
      `verify-at-stop: this turn edited ${names.length} code file${names.length > 1 ? 's' : ''} (${shown}) and no check ` +
      'ran after the last edit. Run the gate that covers them NOW — the project type-check/lint/test, or the suite ' +
      "for these files — and read its whole output. Then finish with the summary in the user's language, stating what was executed " +
      'and whether it was green. If no check can run here, say so explicitly in the summary with the reason. ' +
      'Do not redo anything else.',
  };
}
