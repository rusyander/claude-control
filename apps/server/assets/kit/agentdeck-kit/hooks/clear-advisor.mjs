#!/usr/bin/env node
// From the second compaction in a session, offers /clear while the context is at its cheapest.
// Kit hook item: run by the event dispatcher (lib/run.mjs) or on its own; see lib/items.mjs.
import clearAdvisor from './lib/postcompact-clear-advisor.mjs';
import { runIfMain } from './lib/items.mjs';

export const hooks = { postcompact: clearAdvisor };

await runIfMain(import.meta.url, 'clear-advisor', { hooks });
