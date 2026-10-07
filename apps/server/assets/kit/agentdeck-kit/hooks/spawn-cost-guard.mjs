#!/usr/bin/env node
// Asks before a subagent or workflow fan-out runs on the top model without the user having seen how many and on which model.
// Kit hook item: run by the event dispatcher (lib/run.mjs) or on its own; see lib/items.mjs.
import spawnCostGuard from './lib/spawn-cost-guard.mjs';
import { runIfMain, TOOLS } from './lib/items.mjs';

export const hooks = { pre: { tools: TOOLS.SPAWN, run: spawnCostGuard } };

await runIfMain(import.meta.url, 'spawn-cost-guard', { hooks });
