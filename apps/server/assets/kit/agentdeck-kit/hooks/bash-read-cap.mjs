#!/usr/bin/env node
// Split group: a shell command printing whole files or a whole-branch diff above the cap → ranges / --stat instead.
// Kit hook item: run by the event dispatcher (lib/run.mjs) or on its own; see lib/items.mjs.
import mod from './lib/bash-read-cap.mjs';
import { runIfMain, TOOLS } from './lib/items.mjs';

export const hooks = { pre: { tools: TOOLS.BASH, run: mod } };

await runIfMain(import.meta.url, 'bash-read-cap', { hooks });
