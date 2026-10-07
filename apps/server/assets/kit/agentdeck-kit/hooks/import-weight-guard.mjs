#!/usr/bin/env node
// Stops a heavy dependency import landing in a hot path without a word about its weight.
// Kit hook item: run by the event dispatcher (lib/run.mjs) or on its own; see lib/items.mjs.
import importWeightGuard from './lib/import-weight-guard.mjs';
import { runIfMain, TOOLS } from './lib/items.mjs';

export const hooks = { pre: { tools: TOOLS.EDIT, run: importWeightGuard } };

await runIfMain(import.meta.url, 'import-weight-guard', { hooks });
