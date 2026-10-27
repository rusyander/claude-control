#!/usr/bin/env node
// A panel group turn that hit refusals or tool errors and left the copy's notebook unchanged is stopped once to write the facts down.
// Kit hook item: run by the event dispatcher (lib/run.mjs) or on its own; see lib/items.mjs.
import notebookAtStop from './lib/notebook-at-stop.mjs';
import { runIfMain } from './lib/items.mjs';

export const hooks = { stop: notebookAtStop };

await runIfMain(import.meta.url, 'notebook-at-stop', { hooks });
