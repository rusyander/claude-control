#!/usr/bin/env node
// Before a compaction, stamps .agent/PROGRESS.md and asks for it to be brought up to date.
// Kit hook item: run by the event dispatcher (lib/run.mjs) or on its own; see lib/items.mjs.
import precompactCheckpoint from './lib/precompact-checkpoint.mjs';
import { runIfMain } from './lib/items.mjs';

export const hooks = { precompact: precompactCheckpoint };

await runIfMain(import.meta.url, 'precompact-checkpoint', { hooks });
