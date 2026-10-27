#!/usr/bin/env node
// A split group runs dev servers, builds and shot scripts only from its own copy, never from the main checkout or another worktree.
// Kit hook item: run by the event dispatcher (lib/run.mjs) or on its own; see lib/items.mjs.
import ownCopyGuard, { SHELL } from './lib/own-copy-guard.mjs';
import { runIfMain } from './lib/items.mjs';

export const hooks = {
  pre: {
    tools: SHELL,
    run: ownCopyGuard,
  },
};

await runIfMain(import.meta.url, 'own-copy-guard', { hooks });
