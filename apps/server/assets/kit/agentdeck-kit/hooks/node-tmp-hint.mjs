#!/usr/bin/env node
// On Windows: a node call naming /tmp inside its code (-e, -p, here-doc) gets a hint — node.exe reads /tmp as C:\tmp.
// Kit hook item: run by the event dispatcher (lib/run.mjs) or on its own; see lib/items.mjs.
import nodeTmpHint from './lib/node-tmp-hint.mjs';
import { runIfMain } from './lib/items.mjs';

// A hint, never a verdict: it rides with the situational rules, only when no guard refused the call.
export const hooks = { rules: (input) => nodeTmpHint(input) };

await runIfMain(import.meta.url, 'node-tmp-hint', { hooks });
