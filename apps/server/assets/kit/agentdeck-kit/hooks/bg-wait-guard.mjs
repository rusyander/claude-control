#!/usr/bin/env node
// No sleep-polling of a background command: its completion notification wakes the session.
// Kit hook item: run by the event dispatcher (lib/run.mjs) or on its own; see lib/items.mjs.
import mod from './lib/bg-wait-guard.mjs';
import { runIfMain, TOOLS } from './lib/items.mjs';

export const hooks = { pre: { tools: TOOLS.BASH, run: mod } };

await runIfMain(import.meta.url, 'bg-wait-guard', { hooks });
