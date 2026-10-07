#!/usr/bin/env node
// A reply to a user who writes in Cyrillic is not sent in Latin script alone.
// Kit hook item: run by the event dispatcher (lib/run.mjs) or on its own; see lib/items.mjs.
import replyLanguage from './lib/reply-language.mjs';
import { runIfMain } from './lib/items.mjs';

export const hooks = { stop: replyLanguage };

await runIfMain(import.meta.url, 'reply-language', { hooks });
