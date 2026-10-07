#!/usr/bin/env node
// A subagent prompt carries its return format and the no-subagents line, so a fan-out stays one level deep and its output stays small.
// Kit hook item: run by the event dispatcher (lib/run.mjs) or on its own; see lib/items.mjs.
import agentPromptGuard from './lib/agent-prompt-guard.mjs';
import { runIfMain, TOOLS } from './lib/items.mjs';

export const hooks = { pre: { tools: TOOLS.SPAWN, run: agentPromptGuard } };

await runIfMain(import.meta.url, 'agent-prompt-guard', { hooks });
