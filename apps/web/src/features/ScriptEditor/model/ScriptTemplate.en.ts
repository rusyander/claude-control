import type { ScriptTemplate } from './ScriptTemplate.types';

/**
 * Английские копии заготовок из `ScriptTemplate.ts` — те же id, имена файлов и
 * код, по-английски только подписи, комментарии и строки для человека. Код в
 * двух копиях держат одни и те же проверки (`ScriptTemplate.test.ts` гоняет
 * регулярки и шебанги по обоим языкам), так что правка одной копии без другой
 * всплывёт.
 */
export const NEW_SCRIPT_TEMPLATE_EN = `#!/usr/bin/env node
/**
 * Description: what the script does and which event it fires on.
 */

let raw = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  raw += chunk;
});

process.stdin.on('end', () => {
  const event = raw ? JSON.parse(raw) : {};

  // Hook logic goes here. event.tool_name, event.tool_input and other fields
  // are available depending on the event.

  // A message for Claude is plain stdout output:
  // process.stdout.write('text');

  // To block the action, exit with code 2 and write the reason to stderr:
  // process.stderr.write('reason'); process.exit(2);

  process.exit(0);
});
`;

export const GENERIC_SCRIPT_TEMPLATE_EN = `#!/usr/bin/env node
/**
 * Description: what the script does and how it is run.
 */

// Command-line arguments: node script.mjs one two
const args = process.argv.slice(2);

process.stdout.write(\`Started with arguments: \${args.join(' ') || '(none)'}\\n\`);

// A non-zero exit code tells the caller something went wrong.
process.exit(0);
`;

export const SCRIPT_TEMPLATES_EN: ScriptTemplate[] = [
  {
    id: 'blank',
    title: 'Blank skeleton',
    description: 'Reads the event from stdin and leaves room for your logic.',
    fileName: 'new-hook.mjs',
    content: NEW_SCRIPT_TEMPLATE_EN,
  },
  {
    id: 'guard',
    title: 'Command guard',
    description:
      'Checks the command and asks for confirmation on a match (no exit code needed — the decision goes in JSON).',
    fileName: 'guard.mjs',
    content: `#!/usr/bin/env node
/**
 * Guard: checks an action before it runs and asks for confirmation
 * if it looks dangerous.
 */
import { stdin } from 'node:process';

let raw = '';
for await (const chunk of stdin) raw += chunk;

let input;
try {
  input = JSON.parse(raw);
} catch {
  process.exit(0);
}

const command = String(input?.tool_input?.command ?? '');

// The trigger condition — replace it with your own.
if (/rm\\s+-rf|DROP\\s+TABLE/i.test(command)) {
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'ask',
        permissionDecisionReason: 'The command looks destructive — confirmation required.',
      },
    }),
  );
}

process.exit(0);
`,
  },
  {
    id: 'format',
    title: 'Format on save',
    description: 'Runs the formatter on the changed file (PostToolUse on Write/Edit).',
    fileName: 'format-on-edit.mjs',
    content: `#!/usr/bin/env node
/**
 * Silent auto-format of the changed file. Attach it to PostToolUse (Write/Edit).
 */
import { stdin } from 'node:process';
import { execFileSync } from 'node:child_process';

let raw = '';
for await (const chunk of stdin) raw += chunk;

let filePath = '';
try {
  filePath = String(JSON.parse(raw)?.tool_input?.file_path ?? '');
} catch {
  process.exit(0);
}

if (/\\.(ts|tsx|js|jsx|json|css|scss|md)$/.test(filePath)) {
  try {
    execFileSync('npx', ['prettier', '--write', filePath], { stdio: 'ignore' });
  } catch {
    // The formatter is unavailable — stay out of the way.
  }
}

process.exit(0);
`,
  },
  {
    id: 'brief',
    title: 'Session start brief',
    description: 'Adds context at the start of a session (SessionStart).',
    fileName: 'session-brief.mjs',
    content: `#!/usr/bin/env node
/**
 * Session start brief: adds a reminder to Claude's context.
 */
process.stdout.write(
  JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'SessionStart',
      additionalContext: 'Reminder: check .agent/notes.md before starting work.',
    },
  }),
);

process.exit(0);
`,
  },
];

export const GENERIC_SCRIPT_TEMPLATES_EN: ScriptTemplate[] = [
  {
    id: 'generic-blank',
    title: 'Blank skeleton',
    description: 'Arguments, output and exit code — room for your own logic.',
    fileName: 'new-script.mjs',
    content: GENERIC_SCRIPT_TEMPLATE_EN,
  },
  {
    id: 'generic-command',
    title: 'Run a command',
    description: 'Calls an external command and passes its exit code on.',
    fileName: 'run-command.mjs',
    content: `#!/usr/bin/env node
/**
 * A wrapper around an external command: runs it and returns its exit code.
 */
import { spawnSync } from 'node:child_process';

// What to run — replace it with your own.
const result = spawnSync('npm', ['--version'], { stdio: 'inherit' });

process.exit(result.status ?? 1);
`,
  },
];
