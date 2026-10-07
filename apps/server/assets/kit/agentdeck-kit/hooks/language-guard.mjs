#!/usr/bin/env node
// Agent docs are written in English; human-facing or marked files are left alone.
// Kit hook item: run by the event dispatcher (lib/run.mjs) or on its own; see lib/items.mjs.
import languageGuard from './lib/language-guard.mjs';
import { runIfMain, TOOLS } from './lib/items.mjs';

export const hooks = { pre: { tools: TOOLS.EDIT, run: languageGuard } };

await runIfMain(import.meta.url, 'language-guard', { hooks });
