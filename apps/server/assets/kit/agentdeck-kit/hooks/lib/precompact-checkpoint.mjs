// PreCompact: make the checkpoint REAL, not just requested. PROGRESS.md is the handoff artifact —
// the post-compact session restores from it, so it must stand on its own without the conversation.
//
// 1. Stamp .agent/PROGRESS.md with a compaction marker (creating a skeleton when the file is
//    missing, and only when the project already has an `.agent/` folder) — so the restore side
//    always finds a file, and a stale checkpoint is visibly stale. The hook writes the stub itself
//    because PreCompact output is not guaranteed to reach the model on every CLI; a file write is.
// 2. Return the update instruction — where PreCompact output IS surfaced, the model updates the
//    sections properly before the summary is cut.
// (Clearing this session's rule stamps is the dispatcher's job: it must happen even when this item
// is switched off, or the situational rules lapse for the rest of a long session.)
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const MARKER = /^<!-- precompact:.*-->\r?\n?/;
const SKELETON =
  '# PROGRESS\n\n## Done + verified\n\n## In progress\n\n## Left + blockers\n\n## Key decisions\n\n## Important paths\n\n## Next skills\n';

export const INSTRUCTION =
  'Before compaction: update .agent/PROGRESS.md so the post-compact session can continue without ' +
  'the transcript. Sections: done+verified / in progress / left+blockers / key decisions / ' +
  'important paths, plus "next skills" — the skills the remaining work needs, by name. ' +
  'Reference specs, TASKS.md, diffs, issues and ADRs by path or URL; do not copy their content in. ' +
  'Redact tokens, passwords and personal data. Record only what the transcript would lose.\n' +
  'Then keep the SUMMARY ITSELF SHORT — it becomes the floor of the new context and is re-billed ' +
  'on every request until the next compaction, so every line kept costs the whole rest of the ' +
  'session. Detail belongs in PROGRESS.md; the summary points at it by path and states only the ' +
  'current task, the immediate next step, and decisions that would be re-litigated without it. ' +
  'Do not restate file contents, command output or anything already written to disk.';

/** @returns {string} the instruction for the model (the stamp is a side effect). */
export default function precompactCheckpoint(input) {
  const cwd = String(input?.cwd || process.cwd());
  try {
    const agentDir = join(cwd, '.agent');
    if (existsSync(agentDir)) {
      const file = join(agentDir, 'PROGRESS.md');
      const stamp = `<!-- precompact: compaction at ${new Date().toISOString()} — sections below may predate it; reconcile with the summary -->\n`;
      const body = existsSync(file) ? readFileSync(file, 'utf8').replace(MARKER, '') : SKELETON;
      writeFileSync(file, stamp + body, 'utf8');
    }
  } catch {
    /* a checkpoint stamp must never block compaction */
  }
  return INSTRUCTION;
}
