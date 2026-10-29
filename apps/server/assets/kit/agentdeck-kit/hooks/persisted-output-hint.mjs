#!/usr/bin/env node
// A Bash output too large to show inline: the model is told it saw only the preview and where the whole output is.
// Kit hook item: run by the event dispatcher (lib/run.mjs) or on its own; see lib/items.mjs.
import persistedOutputHint from './lib/persisted-output-hint.mjs';
import { runIfMain, TOOLS } from './lib/items.mjs';

export const hooks = {
  'post-any': { tools: TOOLS.BASH, run: (input) => persistedOutputHint(input) },
};

await runIfMain(import.meta.url, 'persisted-output-hint', { hooks });
