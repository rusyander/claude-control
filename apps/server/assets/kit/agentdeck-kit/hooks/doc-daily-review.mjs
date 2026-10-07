#!/usr/bin/env node
// Once a day, lists agent docs that went stale or dead so they are pruned instead of re-billed.
// Kit hook item: run by the event dispatcher (lib/run.mjs) or on its own; see lib/items.mjs.
import docDailyReview from './lib/doc-daily-review.mjs';
import { runIfMain } from './lib/items.mjs';

export const hooks = { 'post-edit': docDailyReview };

await runIfMain(import.meta.url, 'doc-daily-review', { hooks });
