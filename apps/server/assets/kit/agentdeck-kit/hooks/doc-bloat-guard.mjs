#!/usr/bin/env node
// Flags an agent doc that grew past its size budget right after the edit.
// Kit hook item: run by the event dispatcher (lib/run.mjs) or on its own; see lib/items.mjs.
import docBloatGuard from './lib/doc-bloat-guard.mjs';
import { runIfMain } from './lib/items.mjs';

export const hooks = { 'post-edit': docBloatGuard };

await runIfMain(import.meta.url, 'doc-bloat-guard', { hooks });
