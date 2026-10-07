#!/usr/bin/env node
// Agent docs go to one place per repo (CLAUDE.md or AGENTS.md + .agent/); a doc written elsewhere is redirected.
// Kit hook item: run by the event dispatcher (lib/run.mjs) or on its own; see lib/items.mjs.
import agentDocLocation from './lib/agent-doc-location.mjs';
import { runIfMain, TOOLS } from './lib/items.mjs';

export const hooks = { pre: { tools: TOOLS.EDIT, run: agentDocLocation } };

await runIfMain(import.meta.url, 'agent-doc-location', { hooks });
