#!/usr/bin/env node
// PreToolUse (Bash): commands that destroy work nobody can get back are not run silently —
// the CLI asks the human first. Everything else passes untouched (no output = no opinion).
import { readFileSync } from 'node:fs';
import { normalize } from './lib/kit-paths.mjs';

/** [pattern, reason shown to the human]. Kept narrow: a guard that asks on every command gets switched off. */
export const RULES = [
  // Flags are looked for up to the end of THIS command: `git push && rm -f tmp` is not a force push.
  [
    /\bgit\s+push\b[^\n;&|]*(?:--force\b|--force-with-lease\b|\s-f\b)/,
    'force push rewrites remote history',
  ],
  [/\bgit\s+reset\s+--hard\b/, 'git reset --hard drops uncommitted changes'],
  // -f anywhere among the options (`-fd`, `-d -f`, `--force`); `-n` (dry run) passes.
  [/\bgit\s+clean\b[^\n;&|]*\s(?:-[a-z]*f|--force\b)/, 'git clean deletes untracked files'],
  [/\bgit\s+checkout\s+(?:--\s+)?\.(?:\s|$)/, 'git checkout . drops uncommitted changes'],
  [/\bgit\s+branch\s+-D\b/, 'git branch -D deletes an unmerged branch'],
  // The root or home itself, with or without a trailing slash or `*` (`/`, `/*`, `~/`, `$HOME/`,
  // `C:\`); flags split or joined (`-rf`, `-r -f`). A folder below them (`~/old`, `/tmp/x`) passes.
  [
    /\brm\s+(?:-[a-zA-Z]+\s+)*-[a-zA-Z]*[rR][a-zA-Z]*\s+(?:-[a-zA-Z]+\s+)*(?:\/|~|\$HOME|\$\{HOME\}|[A-Za-z]:)[\\/]?\*?(?=\s|$|[;&|])/,
    'recursive delete of a root or home folder',
  ],
  [/\b(?:drop\s+(?:database|table|schema)|truncate\s+table)\b/i, 'destructive SQL'],
];

export function verdict(command) {
  for (const [pattern, reason] of RULES) if (pattern.test(command)) return reason;
  return null;
}

function main() {
  let input;
  try {
    input = JSON.parse(readFileSync(0, 'utf8') || '{}');
  } catch {
    return;
  }
  // `null` or a bare value on stdin is still "no opinion", never a crash the CLI reports as a hook error.
  // Qwen Code names its shell `run_shell_command` — normalised to `Bash` like every other kit guard.
  const [call] = normalize(input);
  if (call?.tool_name !== 'Bash') return;
  const reason = verdict(String(call.tool_input?.command ?? ''));
  if (!reason) return;
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'ask',
        permissionDecisionReason: `agentdeck kit: ${reason}`,
      },
    }),
  );
}

// Imported by a test → only the rules; run by the CLI → read the call from stdin.
if (process.argv[1]?.endsWith('guard-destructive.mjs')) main();
