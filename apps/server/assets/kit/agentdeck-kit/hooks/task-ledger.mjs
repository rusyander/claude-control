#!/usr/bin/env node
// Every accepted task is a line in TASKS.md and every finished item is marked there: a turn whose ledger lags is stopped once; a subagent never writes it.
// Kit hook item: run by the event dispatcher (lib/run.mjs) or on its own; see lib/items.mjs.
import taskLedgerWriter, { taskLedgerAtStop } from './lib/task-ledger.mjs';
import { runIfMain, TOOLS } from './lib/items.mjs';

export const hooks = {
  pre: { tools: TOOLS.EDIT, run: taskLedgerWriter },
  stop: taskLedgerAtStop,
};

await runIfMain(import.meta.url, 'task-ledger', { hooks });
