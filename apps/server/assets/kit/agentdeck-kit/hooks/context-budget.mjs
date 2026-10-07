#!/usr/bin/env node
// At session start, one line when the auto-loaded project memory is over budget or duplicated.
// Kit hook item: run by the event dispatcher (lib/run.mjs) or on its own; see lib/items.mjs.
import contextBudget from './lib/context-budget.mjs';
import { runIfMain } from './lib/items.mjs';

export const hooks = { session: contextBudget };

await runIfMain(import.meta.url, 'context-budget', { hooks });
