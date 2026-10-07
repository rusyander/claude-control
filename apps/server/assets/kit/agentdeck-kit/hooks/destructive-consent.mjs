#!/usr/bin/env node
// Deleting real files, discarding the working copy, DROP/TRUNCATE, kubectl/helm deletes and docker volume wipes need the user's words; agent scratch zones and regenerable caches pass.
// Kit hook item: run by the event dispatcher (lib/run.mjs) or on its own; see lib/items.mjs.
import destructiveGuard from './lib/destructive-guard.mjs';
import { runIfMain, TOOLS } from './lib/items.mjs';

export const hooks = { pre: { tools: TOOLS.BASH, run: destructiveGuard } };

await runIfMain(import.meta.url, 'destructive-consent', { hooks });
