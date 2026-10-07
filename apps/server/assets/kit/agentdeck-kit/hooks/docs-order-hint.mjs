#!/usr/bin/env node
// "Put the docs in order" routes to the docs-triage skill instead of an ad-hoc cleanup.
// Kit hook item: run by the event dispatcher (lib/run.mjs) or on its own; see lib/items.mjs.
import docsOrderHint from './lib/prompt/docs-order-hint.mjs';
import { runIfMain } from './lib/items.mjs';

export const hooks = { prompt: docsOrderHint };

await runIfMain(import.meta.url, 'docs-order-hint', { hooks });
