#!/usr/bin/env node
// In a panel group run, a re-post of the MR description waits for a delivery check that passed on the new text.
// Kit hook item: run by the event dispatcher (lib/run.mjs) or on its own; see lib/items.mjs.
import mrDescriptionGate from './lib/mr-description-gate.mjs';
import { runIfMain, TOOLS } from './lib/items.mjs';

export const hooks = {
  pre: {
    tools: new RegExp(
      `${TOOLS.BASH.source}|${TOOLS.FORGE.source}|${TOOLS.FORGE_OPENCODE.source}`,
      'i',
    ),
    run: mrDescriptionGate,
  },
};

await runIfMain(import.meta.url, 'mr-description-gate', { hooks });
