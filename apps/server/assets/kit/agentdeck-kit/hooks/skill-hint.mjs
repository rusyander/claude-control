#!/usr/bin/env node
// Names at most two kit skills that fit the situation in the prompt; silent on mechanical work.
// Kit hook item: run by the event dispatcher (lib/run.mjs) or on its own; see lib/items.mjs.
import skillHint from './lib/prompt/skill-hint.mjs';
import { runIfMain } from './lib/items.mjs';

export const hooks = { prompt: skillHint };

await runIfMain(import.meta.url, 'skill-hint', { hooks });
