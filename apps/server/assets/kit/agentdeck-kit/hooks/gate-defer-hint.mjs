#!/usr/bin/env node
// A follow-up prompt moves once-at-end stages to the end and stops a running full gate.
// Kit hook item: run by the event dispatcher (lib/run.mjs) or on its own; see lib/items.mjs.
import mod from './lib/prompt/gate-defer-hint.mjs';
import { runIfMain } from './lib/items.mjs';

export const hooks = { prompt: mod };

await runIfMain(import.meta.url, 'gate-defer-hint', { hooks });
