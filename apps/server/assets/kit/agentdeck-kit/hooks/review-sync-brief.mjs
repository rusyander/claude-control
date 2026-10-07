#!/usr/bin/env node
// At session start in a project whose `.agent/reviews/` holds published findings still waiting on the
// MR author: one line when authors answered or other reviewers opened threads since the last look.
// Local files only; a detached GET-only refresh through the user's glab login runs at most once a day.
// Kit hook item: run by the event dispatcher (lib/run.mjs) or on its own; see lib/items.mjs.
import { brief } from '../tools/review-sync-brief.mjs';
import { runIfMain } from './lib/items.mjs';

export const hooks = { session: (input) => brief(input?.cwd || process.cwd()) };

await runIfMain(import.meta.url, 'review-sync-brief', { hooks });
