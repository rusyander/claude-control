#!/usr/bin/env node
// Merging an MR/PR stays the user's: gh pr merge, glab mr merge, the REST merge call and the forge MCP merge tools are refused, with no consent door.
// Kit hook item: run by the event dispatcher (lib/run.mjs) or on its own; see lib/items.mjs.
import forgeMergeGuard from './lib/forge-merge-guard.mjs';
import { runIfMain, TOOLS } from './lib/items.mjs';

export const hooks = {
  pre: {
    tools: new RegExp(
      `${TOOLS.BASH.source}|${TOOLS.FORGE.source}|${TOOLS.FORGE_OPENCODE.source}`,
      'i',
    ),
    run: forgeMergeGuard,
  },
};

await runIfMain(import.meta.url, 'forge-merge-guard', { hooks });
