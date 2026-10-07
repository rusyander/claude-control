#!/usr/bin/env node
// Formats the edited file with the project's own configured formatter (prettier, gofmt, ruff), silently.
// Kit hook item: run by the event dispatcher (lib/run.mjs) or on its own; see lib/items.mjs.
import formatOnEdit from './lib/format-on-edit.mjs';
import { runIfMain } from './lib/items.mjs';

export const hooks = { 'post-edit': formatOnEdit };

await runIfMain(import.meta.url, 'format-on-edit', { hooks });
