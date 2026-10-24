#!/usr/bin/env node
// SessionStart: hand the kit rules to the model as additional context.
// Every rules/*.md goes in; local.md only with AGENTDECK_KIT_VARIANT=local (one tool per step,
// explicit call format, no parallel subagents — discipline for small local models).
// Split group (phase G.2): a stage of a panel split group (AGENTDECK_SPLIT_CHILD=1) whose user
// memory the panel took out (AGENTDECK_USER_MEMORY_OFF=1) gets the group rules card
// (`hooks/cards/group-rules.md`, ~1.9k chars) instead of the whole rules text (~8.7k) — on every
// SessionStart, compaction included, because hook context does not survive a compaction. Both
// markers or nothing; a missing card falls back to the whole text, never to no rules.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..', 'rules');
const local = (process.env.AGENTDECK_KIT_VARIANT ?? '').trim() === 'local';

function readCard() {
  if (process.env.AGENTDECK_SPLIT_CHILD !== '1' || process.env.AGENTDECK_USER_MEMORY_OFF !== '1')
    return '';
  try {
    return readFileSync(join(here, 'cards', 'group-rules.md'), 'utf8').trim();
  } catch {
    return '';
  }
}

const card = readCard();
const names = existsSync(root)
  ? readdirSync(root)
      // With the card only local.md stays: it narrows the work of a small model, the card does not.
      .filter(
        (name) =>
          name.endsWith('.md') && (local || name !== 'local.md') && (!card || name === 'local.md'),
      )
      // local.md goes last: it narrows the general rules, never replaces them.
      .sort((a, b) => Number(a === 'local.md') - Number(b === 'local.md') || a.localeCompare(b))
  : [];
const additionalContext = [
  card,
  ...names.map((name) => {
    try {
      return readFileSync(join(root, name), 'utf8').trim();
    } catch {
      return '';
    }
  }),
]
  .filter(Boolean)
  .join('\n\n');
// Skill text says `<kit>/tools/…`; the model cannot know where the CLI unpacked the kit.
const kitLine = `Kit root (\`<kit>\` in skill text): ${join(root, '..').split('\\').join('/')}`;
process.stdout.write(
  JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'SessionStart',
      // Root line first: local.md must stay the last word.
      additionalContext: additionalContext ? `${kitLine}\n\n${additionalContext}` : kitLine,
    },
  }),
);
