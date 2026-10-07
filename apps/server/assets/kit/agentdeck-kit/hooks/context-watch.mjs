#!/usr/bin/env node
// In a long session, asks for a fresh .agent/PROGRESS.md checkpoint as the context grows, so a compaction or /clear loses nothing.
// Kit hook item: run by the event dispatcher (lib/run.mjs) or on its own; see lib/items.mjs.
import contextWatch from './lib/context-watch.mjs';
import { runIfMain } from './lib/items.mjs';

export const hooks = { 'post-any': contextWatch };

await runIfMain(import.meta.url, 'context-watch', { hooks });
