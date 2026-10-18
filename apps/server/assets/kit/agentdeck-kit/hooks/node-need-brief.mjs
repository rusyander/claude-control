#!/usr/bin/env node
// At session start in a project asking for a Node version the session's PATH does not give: the best
// installed match goes first in Bash PATH through CLAUDE_ENV_FILE, plus one line saying so. Silent when
// PATH already fits or the project asks for nothing.
// Kit hook item: run by the event dispatcher (lib/run.mjs) or on its own; see lib/items.mjs.
import { brief } from '../tools/node-need-brief.mjs';
import { runIfMain } from './lib/items.mjs';

export const hooks = { session: (input) => brief(input?.cwd || process.cwd()) };

await runIfMain(import.meta.url, 'node-need-brief', { hooks });
