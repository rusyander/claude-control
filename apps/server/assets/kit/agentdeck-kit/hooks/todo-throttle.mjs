#!/usr/bin/env node
// Keeps the todo list to one plan and one closing write instead of a rewrite after every step.
// Kit hook item: run by the event dispatcher (lib/run.mjs) or on its own; see lib/items.mjs.
import todoThrottle from './lib/todo-throttle.mjs';
import { runIfMain, TOOLS } from './lib/items.mjs';

export const hooks = { pre: { tools: TOOLS.CTX, run: todoThrottle } };

await runIfMain(import.meta.url, 'todo-throttle', { hooks });
