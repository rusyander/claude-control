#!/usr/bin/env node
// Three model turns in a row that each ran one short read-only command → batch independent reads.
// Kit hook item: run by the event dispatcher (lib/run.mjs) or on its own; see lib/items.mjs.
import mod from './lib/batch-nudge.mjs';
import { runIfMain, TOOLS } from './lib/items.mjs';

export const hooks = { 'post-any': { tools: TOOLS.BASH, run: mod } };

await runIfMain(import.meta.url, 'batch-nudge', { hooks });
