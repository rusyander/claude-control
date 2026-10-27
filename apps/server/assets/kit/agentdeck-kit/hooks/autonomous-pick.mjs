#!/usr/bin/env node
// Autonomous run with full access: a question with a recommended option on every line is answered at once with that option, the way the panel answers it everywhere else.
// Kit hook item: run by the event dispatcher (lib/run.mjs) or on its own; see lib/items.mjs.
import autonomousPick from './lib/autonomous-pick.mjs';
import { runIfMain, TOOLS } from './lib/items.mjs';

export const hooks = { pre: { tools: TOOLS.ASK, run: autonomousPick } };

await runIfMain(import.meta.url, 'autonomous-pick', { hooks });
