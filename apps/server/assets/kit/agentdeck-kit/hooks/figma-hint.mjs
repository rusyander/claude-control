#!/usr/bin/env node
// A figma.com link in the prompt points at the figma-parity skill and the Figma MCP.
// Kit hook item: run by the event dispatcher (lib/run.mjs) or on its own; see lib/items.mjs.
import figmaHint from './lib/prompt/figma-hint.mjs';
import { runIfMain } from './lib/items.mjs';

export const hooks = { prompt: figmaHint };

await runIfMain(import.meta.url, 'figma-hint', { hooks });
