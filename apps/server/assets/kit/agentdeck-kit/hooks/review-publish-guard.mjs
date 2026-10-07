#!/usr/bin/env node
// A review comment is published only after a fresh read of the thread list of that MR/PR (MCP or glab/gh).
// Kit hook item: run by the event dispatcher (lib/run.mjs) or on its own; see lib/items.mjs.
import reviewPublishGuard, { recordReviewRead } from './lib/review-publish-guard.mjs';
import { runIfMain, TOOLS } from './lib/items.mjs';

export const hooks = {
  pre: {
    tools: new RegExp(`${TOOLS.BASH.source}|${TOOLS.EDIT.source}|${TOOLS.FORGE.source}`, 'i'),
    run: reviewPublishGuard,
  },
  'post-any': recordReviewRead,
};

await runIfMain(import.meta.url, 'review-publish-guard', { hooks });
