#!/usr/bin/env node
// On a local model: no background commands (a background subagent is allowed, see lib/local-discipline.mjs).
// Kit hook item: run by the event dispatcher (lib/run.mjs) or on its own; see lib/items.mjs.
import localDiscipline from './lib/local-discipline.mjs';
import { runIfMain } from './lib/items.mjs';

export const hooks = { pre: { tools: /^(Bash|PowerShell|Agent|Task)$/, run: localDiscipline } };

await runIfMain(import.meta.url, 'local-discipline', { hooks });
