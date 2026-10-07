#!/usr/bin/env node
// A real-looking secret never reaches a file or a command line; integration credentials live in the panel store.
// Kit hook item: run by the event dispatcher (lib/run.mjs) or on its own; see lib/items.mjs.
import secretGuard from './lib/secret-guard.mjs';
import { runIfMain, TOOLS } from './lib/items.mjs';

export const hooks = {
  pre: { tools: new RegExp(`${TOOLS.BASH.source}|${TOOLS.EDIT.source}`), run: secretGuard },
};

await runIfMain(import.meta.url, 'secret-guard', { hooks });
