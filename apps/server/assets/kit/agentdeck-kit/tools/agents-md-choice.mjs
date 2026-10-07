// Record which file a project's instructions live in, so the AGENTS.md offer is made once and never
// again. Run right after the user answers; `project-onboard-check.mjs` reads this and goes silent.
//
//   node <kit>/tools/agents-md-choice.mjs <project-dir> keep    stays CLAUDE.md
//   node <kit>/tools/agents-md-choice.mjs <project-dir> moved   instructions live in AGENTS.md
//   node <kit>/tools/agents-md-choice.mjs --list
import {
  setInstructionChoice,
  listInstructionChoices,
  NAMING_STORE_PATH,
} from '../hooks/lib/doc-policy.mjs';

const [, , rawDir, rawChoice] = process.argv;

if (rawDir === '--list' || !rawDir) {
  const rows = listInstructionChoices();
  if (!rows.length)
    console.log('no project has an answer yet — the AGENTS.md offer has not been made');
  for (const [dir, rec] of rows) console.log(`${dir} — ${rec.choice} (${rec.since})`);
  console.log(`\nstore: ${NAMING_STORE_PATH}`);
  process.exit(0);
}

if (rawChoice !== 'keep' && rawChoice !== 'moved') {
  console.error(
    'second argument: keep (stays CLAUDE.md) or moved (instructions live in AGENTS.md)',
  );
  process.exit(1);
}

const root = setInstructionChoice(rawDir, rawChoice);
if (!root) {
  console.error('could not write the store');
  process.exit(1);
}
console.log(`${root} → ${rawChoice}`);
