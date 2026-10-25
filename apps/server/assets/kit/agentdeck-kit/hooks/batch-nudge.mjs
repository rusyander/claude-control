#!/usr/bin/env node
// Three model turns in a row that each ran one short read-only command → batch independent reads.
// In a split group the run is judged before the call (Read/Grep/Glob count, a refusal after ignored lines).
// Kit hook item: run by the event dispatcher (lib/run.mjs) or on its own; see lib/items.mjs.
import mod, { batchPre, takeNudge } from './lib/batch-nudge.mjs';
import { runIfMain, TOOLS } from './lib/items.mjs';

export const hooks = {
  'post-any': { tools: TOOLS.BASH, run: mod },
  pre: { tools: TOOLS.CTX, run: batchPre },
  // The [batch] line `batchPre` decided on rides with the situational rules (only when nothing refused).
  rules: () => takeNudge(),
};

await runIfMain(import.meta.url, 'batch-nudge', { hooks });
