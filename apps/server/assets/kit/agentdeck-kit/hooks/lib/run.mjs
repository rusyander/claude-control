#!/usr/bin/env node
// Kit hook dispatcher: `node run.mjs <event>` — one process per hook event runs every kit item
// present for it (see items.mjs). Silent on anything it cannot parse; never exits non-zero.
import { readInput } from './dispatch.mjs';
import { runEvent } from './items.mjs';

try {
  const input = await readInput();
  await runEvent(String(process.argv[2] ?? ''), input);
} catch {
  /* a broken dispatcher must never fail the tool call it guards */
}
process.exit(0);
