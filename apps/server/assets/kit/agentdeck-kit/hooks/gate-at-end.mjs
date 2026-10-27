#!/usr/bin/env node
// The full gate runs once, at the end of the whole task: a follow-up gets narrow checks.
// Kit hook item: run by the event dispatcher (lib/run.mjs) or on its own; see lib/items.mjs.
import mod from './lib/gate-at-end.mjs';
import { runIfMain, TOOLS } from './lib/items.mjs';
// The dispatcher asks it before keeping a logged repeat escape (Qwen, Codex): none in a delivery stage.
export { repeatEscapes } from './lib/gate-at-end.mjs';

export const hooks = { pre: { tools: TOOLS.CTX, run: mod } };

await runIfMain(import.meta.url, 'gate-at-end', { hooks });
