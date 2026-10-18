#!/usr/bin/env node
// File edits through inline code (node -e, python heredoc, sed -i) go through Edit/Write instead.
// Kit hook item: run by the event dispatcher (lib/run.mjs) or on its own; see lib/items.mjs.
import mod from './lib/inline-edit-guard.mjs';
import { runIfMain, TOOLS } from './lib/items.mjs';

export const hooks = { pre: { tools: TOOLS.BASH, run: mod } };

await runIfMain(import.meta.url, 'inline-edit-guard', { hooks });
