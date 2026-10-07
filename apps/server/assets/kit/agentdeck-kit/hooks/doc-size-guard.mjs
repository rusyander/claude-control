#!/usr/bin/env node
// A giant document is read by section (Grep, then offset/limit), never whole.
// Kit hook item: run by the event dispatcher (lib/run.mjs) or on its own; see lib/items.mjs.
import docSizeGuard from './lib/doc-size-guard.mjs';
import { runIfMain, TOOLS } from './lib/items.mjs';

export const hooks = { pre: { tools: TOOLS.CTX, run: docSizeGuard } };

await runIfMain(import.meta.url, 'doc-size-guard', { hooks });
