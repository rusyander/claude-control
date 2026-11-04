#!/usr/bin/env node
// Inside a deep-review lane subagent only: one line at the brief's context cap (hand back now), and a batch line after three lone-read turns.
// Kit hook item: run by the event dispatcher (lib/run.mjs) or on its own; see lib/items.mjs.
import laneBudget from './lib/lane-budget.mjs';
import { runIfMain } from './lib/items.mjs';

export const hooks = { 'post-any': laneBudget };

await runIfMain(import.meta.url, 'lane-budget', { hooks });
