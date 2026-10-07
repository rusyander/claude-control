#!/usr/bin/env node
// SessionStart: hand the kit rules to the model as additional context.
// Every rules/*.md goes in; local.md only with AGENTDECK_KIT_VARIANT=local (one tool per step,
// explicit call format, no parallel subagents — discipline for small local models).
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', 'rules');
const local = (process.env.AGENTDECK_KIT_VARIANT ?? '').trim() === 'local';
const names = existsSync(root)
  ? readdirSync(root)
      .filter((name) => name.endsWith('.md') && (local || name !== 'local.md'))
      // local.md goes last: it narrows the general rules, never replaces them.
      .sort((a, b) => Number(a === 'local.md') - Number(b === 'local.md') || a.localeCompare(b))
  : [];
const additionalContext = names
  .map((name) => {
    try {
      return readFileSync(join(root, name), 'utf8').trim();
    } catch {
      return '';
    }
  })
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
