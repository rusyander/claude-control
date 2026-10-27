// Stop module: a panel group turn that hit guard refusals or tool errors and left the copy's notebook
// unchanged does not end silently. Watch audit g9 27.10 (R2): the recheck brief asked for «one line for
// every fact you had to find out»; the notebook kept its 26.10 mtime through a whole recheck, and the
// facts were lost — two cold-transform flakes, the mr_discussions `items` shape (the same mistake again
// after a compaction), plain push after a non-rebase commit, `python3` = the Windows Store stub. The next
// recheck pays the investigation again.
//
// Only in a panel group run (AGENTDECK_GROUP_STAGE) whose copy has the notebook the panel seeded. A
// lesson = a shell or MCP call the CLI refused (a guard, the classifier) or that came back as an error;
// rule cards (a rule to read, not a fact) and Read/Edit/Write misses are not lessons. The notebook counts
// as written when this turn edited it with Edit/Write (a heredoc or `>>` into it is refused by the read
// cap). Blocked once — `stop_hook_active` lets the re-entry through.
// Contract: (input) → { decision:'block', reason } | null.
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import {
  readTail,
  sinceLastCompact,
  toolEvents,
  lastUserSpeech,
  inSubagent,
  wasBlocked,
} from './transcript.mjs';

export const NOTEBOOK = '.agent/run/notebook.agent.md';

const LESSON_TOOL = /^(?:Bash|PowerShell|mcp__.+)$/;
const EDIT_TOOL = /^(?:Write|Edit|MultiEdit)$/;
const NOT_A_FACT =
  /^(?:PreToolUse:[^\s:]+ hook error:\s*)?(?:rule-card:|The user doesn't want to proceed|Permission for this action was denied)/;

const isNotebook = (path) => /(?:^|[\\/])\.agent[\\/]run[\\/]notebook\.agent\.md$/.test(path);

/** The turn's lessons (first line of each body) and whether the notebook was edited after the last one. */
export function notebookOwed(events) {
  const tools = new Map();
  const lessons = [];
  let lastLesson = -1;
  let lastNote = -1;
  events.forEach((e, i) => {
    if (e.kind === 'use') {
      tools.set(e.id, e.name);
      const path = String(e.input?.file_path ?? '');
      if (EDIT_TOOL.test(String(e.name ?? '')) && isNotebook(path)) lastNote = i;
      return;
    }
    if (e.kind !== 'result' || !LESSON_TOOL.test(String(tools.get(e.id) ?? ''))) return;
    const body = String(e.body ?? '').trimStart();
    if (NOT_A_FACT.test(body)) return;
    if (!e.isError && !wasBlocked(body)) return;
    lessons.push(body.split('\n', 1)[0].slice(0, 140));
    lastLesson = i;
  });
  return lessons.length > 0 && lastNote < lastLesson ? lessons : null;
}

export default function notebookAtStop(input) {
  if (!process.env.AGENTDECK_GROUP_STAGE) return null;
  if (input?.stop_hook_active) return null;
  if (inSubagent(input)) return null;
  const cwd = String(input?.cwd ?? process.cwd());
  if (!existsSync(join(cwd, NOTEBOOK))) return null;
  let records;
  try {
    records = sinceLastCompact(readTail(String(input?.transcript_path ?? '')));
  } catch {
    return null;
  }
  if (!records?.length) return null;
  const { index } = lastUserSpeech(records);
  const lessons = notebookOwed(toolEvents(records.slice(index + 1)));
  return lessons ? block(lessons) : null;
}

function block(lessons) {
  const shown = lessons
    .slice(0, 3)
    .map((line) => `«${line}»`)
    .join('; ');
  const more = lessons.length > 3 ? ` (+${lessons.length - 3})` : '';
  return {
    decision: 'block',
    reason:
      `notebook-at-stop: this turn hit ${lessons.length} refusal${lessons.length > 1 ? 's' : ''} or ` +
      `error${lessons.length > 1 ? 's' : ''} — ${shown}${more} — and ${NOTEBOOK} is unchanged. Add one ` +
      'line there with the Edit tool for every fact it taught: what was refused and what passed instead, ' +
      'a tool error and its fix, an environment recipe, a flaky test. A refusal that taught nothing needs ' +
      'no line. Then finish with the same summary; do not redo anything else.',
  };
}
