#!/usr/bin/env node
// Kit hook dispatcher: `node run.mjs <event> [--cli=<name>]` — one process per hook event runs every
// kit item present for it (see items.mjs). `--cli` names the calling CLI for a hook config installed by
// hand (variants/<cli>/); without it the CLI is detected from the input. Silent on anything it cannot
// parse; never exits non-zero.
import { readInput } from './dispatch.mjs';
import { runEvent } from './items.mjs';

const cli = process.argv.slice(3).find((a) => a.startsWith('--cli='));
if (cli) process.env.AGENTDECK_KIT_CLI = cli.slice('--cli='.length);

try {
  const input = await readInput();
  await runEvent(String(process.argv[2] ?? ''), input);
} catch {
  /* a broken dispatcher must never fail the tool call it guards */
}
process.exit(0);
