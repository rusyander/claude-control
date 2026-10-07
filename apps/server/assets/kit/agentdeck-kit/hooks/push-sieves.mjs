#!/usr/bin/env node
// Before a push or MR: cheap sieves over the branch diff (secrets, debug leftovers, lockfile gaps, large files, removed tokens).
// Kit hook item: run by the event dispatcher (lib/run.mjs) or on its own; see lib/items.mjs.
import pushSieves, { takeNote } from './lib/push-sieves.mjs';
export { takeNote };
import { runIfMain, TOOLS } from './lib/items.mjs';

export const hooks = { pre: { tools: TOOLS.BASH, run: pushSieves } };

await runIfMain(import.meta.url, 'push-sieves', { hooks, takeNote });
