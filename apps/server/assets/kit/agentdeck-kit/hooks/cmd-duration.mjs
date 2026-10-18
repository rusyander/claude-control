#!/usr/bin/env node
// Learned command durations: a known-slow command runs in the background or with a timeout that fits it.
// Kit hook item: run by the event dispatcher (lib/run.mjs) or on its own; see lib/items.mjs.
import pre, { cmdDurationPost } from './lib/cmd-duration.mjs';
import { runIfMain, TOOLS } from './lib/items.mjs';

export const hooks = {
  pre: { tools: TOOLS.BASH, run: (input) => pre(input) },
  'post-any': { tools: TOOLS.BASH, run: (input) => cmdDurationPost(input) },
  'post-fail': { tools: TOOLS.BASH, run: (input) => cmdDurationPost(input) },
};

await runIfMain(import.meta.url, 'cmd-duration', { hooks });
