#!/usr/bin/env node
// Steers wide repeated searches toward one targeted query instead of a long chain of greps.
// Kit hook item: run by the event dispatcher (lib/run.mjs) or on its own; see lib/items.mjs.
import searchDiscipline from './lib/search-discipline.mjs';
import { runIfMain, TOOLS } from './lib/items.mjs';

export const hooks = { pre: { tools: TOOLS.CTX, run: searchDiscipline } };

await runIfMain(import.meta.url, 'search-discipline', { hooks });
