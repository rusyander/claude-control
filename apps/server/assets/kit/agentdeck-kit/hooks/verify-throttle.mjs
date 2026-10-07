#!/usr/bin/env node
// Refuses re-running a green check when nothing was edited since; a red run is always free.
// Kit hook item: run by the event dispatcher (lib/run.mjs) or on its own; see lib/items.mjs.
import verifyThrottle from './lib/verify-throttle.mjs';
import { runIfMain, TOOLS } from './lib/items.mjs';

export const hooks = { pre: { tools: TOOLS.CTX, run: verifyThrottle } };

await runIfMain(import.meta.url, 'verify-throttle', { hooks });
