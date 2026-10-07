#!/usr/bin/env node
// A prompt asking for a check, a review or a live run gets the bar named before the work starts.
// Kit hook item: run by the event dispatcher (lib/run.mjs) or on its own; see lib/items.mjs.
import verifyHardHint from './lib/prompt/verify-hard-hint.mjs';
import { runIfMain } from './lib/items.mjs';

export const hooks = { prompt: verifyHardHint };

await runIfMain(import.meta.url, 'verify-hard-hint', { hooks });
