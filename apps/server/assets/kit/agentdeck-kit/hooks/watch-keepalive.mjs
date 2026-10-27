#!/usr/bin/env node
// A live coordinator watch (skill watchdog) keeps its session's turn alive until the user's quoted stop,
// hold.json or every group done; a turn busy elsewhere with no watch call for 10 min gets one alarm line.
// Kit hook item: run by the event dispatcher (lib/run.mjs) or on its own; see lib/items.mjs.
import watchKeepalive, { watchDeadAlarm } from './lib/watch-keepalive.mjs';
import { runIfMain } from './lib/items.mjs';

export const hooks = { stop: watchKeepalive, 'post-any': watchDeadAlarm };

await runIfMain(import.meta.url, 'watch-keepalive', { hooks });
