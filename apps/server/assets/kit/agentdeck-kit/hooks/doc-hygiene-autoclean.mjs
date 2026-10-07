#!/usr/bin/env node
// At session start, sweeps expired scratch in the project's .agent/ (tmp, old screenshots, archive) and flags bloated docs.
// Kit hook item: run by the event dispatcher (lib/run.mjs) or on its own; see lib/items.mjs.
import docHygieneAutoclean from './lib/doc-hygiene-autoclean.mjs';
import { runIfMain } from './lib/items.mjs';

export const hooks = { session: docHygieneAutoclean };

await runIfMain(import.meta.url, 'doc-hygiene-autoclean', { hooks });
