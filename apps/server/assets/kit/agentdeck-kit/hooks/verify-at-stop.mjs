#!/usr/bin/env node
// A turn that edited code and ran no check afterwards is stopped once to run the gate, or to say why it could not.
// Kit hook item: run by the event dispatcher (lib/run.mjs) or on its own; see lib/items.mjs.
import verifyAtStop from './lib/verify-at-stop.mjs';
import { runIfMain } from './lib/items.mjs';

export const hooks = { stop: verifyAtStop };

await runIfMain(import.meta.url, 'verify-at-stop', { hooks });
