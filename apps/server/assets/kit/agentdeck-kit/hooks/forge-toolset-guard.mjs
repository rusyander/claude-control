#!/usr/bin/env node
// A split group activates only the forge MCP categories delivery uses (merge_requests, pipelines).
// Kit hook item: run by the event dispatcher (lib/run.mjs) or on its own; see lib/items.mjs.
import forgeToolsetGuard, { DISCOVER } from './lib/forge-toolset-guard.mjs';
import { runIfMain } from './lib/items.mjs';

export const hooks = {
  pre: {
    tools: DISCOVER,
    run: forgeToolsetGuard,
  },
};

await runIfMain(import.meta.url, 'forge-toolset-guard', { hooks });
