#!/usr/bin/env node
// A whole-project check of one kind mid-task (lint, type-check, the whole suite) → the narrow command instead.
// Kit hook item: run by the event dispatcher (lib/run.mjs) or on its own; see lib/items.mjs.
import mod from './lib/check-cost.mjs';
import { runIfMain, TOOLS } from './lib/items.mjs';

export const hooks = { pre: { tools: TOOLS.BASH, run: mod } };

await runIfMain(import.meta.url, 'check-cost', { hooks });
