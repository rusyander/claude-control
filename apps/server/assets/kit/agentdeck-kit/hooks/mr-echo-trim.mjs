#!/usr/bin/env node
// A split group's MR write (update/create_merge_request) comes back without the forge's echo of the description.
// Kit hook item: run by the event dispatcher (lib/run.mjs) or on its own; see lib/items.mjs.
import mrEchoTrim from './lib/mr-echo-trim.mjs';
import { runIfMain } from './lib/items.mjs';

export const hooks = {
  // An object, not text: the dispatcher sends it as `updatedMCPToolOutput` (Claude only).
  'post-any': (input) => {
    const output = mrEchoTrim(input);
    return output == null ? null : { updatedMCPToolOutput: output };
  },
};

await runIfMain(import.meta.url, 'mr-echo-trim', { hooks });
