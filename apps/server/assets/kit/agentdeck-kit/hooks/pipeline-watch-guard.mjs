#!/usr/bin/env node
// A CI pipeline is not polled unless the user asked: one snapshot at the finish step, no wait loops.
// Kit hook item: run by the event dispatcher (lib/run.mjs) or on its own; see lib/items.mjs.
import pipelineWatchGuard from './lib/pipeline-watch-guard.mjs';
import { runIfMain, TOOLS } from './lib/items.mjs';

export const hooks = {
  pre: {
    tools: new RegExp(`${TOOLS.BASH.source}|${TOOLS.FORGE.source}`, 'i'),
    run: pipelineWatchGuard,
  },
};

await runIfMain(import.meta.url, 'pipeline-watch-guard', { hooks });
