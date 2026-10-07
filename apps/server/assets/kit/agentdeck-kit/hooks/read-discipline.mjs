#!/usr/bin/env node
// Refuses re-reading a file unchanged since this session read it; repeating the identical call is the escape.
// Kit hook item: run by the event dispatcher (lib/run.mjs) or on its own; see lib/items.mjs.
import readDiscipline from './lib/read-discipline.mjs';
import { runIfMain, TOOLS } from './lib/items.mjs';

export const hooks = { pre: { tools: TOOLS.CTX, run: readDiscipline } };

await runIfMain(import.meta.url, 'read-discipline', { hooks });
