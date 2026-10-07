#!/usr/bin/env node
// Git writes need the user's own words: commit, push, rebase, reset and the rest are refused until the user names the op or answers yes.
// Kit hook item: run by the event dispatcher (lib/run.mjs) or on its own; see lib/items.mjs.
import gitGuard from './lib/git-guard.mjs';
import { runIfMain, TOOLS } from './lib/items.mjs';

export const hooks = { pre: { tools: TOOLS.BASH, run: gitGuard } };

await runIfMain(import.meta.url, 'git-guard', { hooks });
