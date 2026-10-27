#!/usr/bin/env node
// A jmespath on the forge MCP's mr_discussions that names neither `items` nor `pagination` returns null — refused before the round trip, with the expression that reads the result.
// Kit hook item: run by the event dispatcher (lib/run.mjs) or on its own; see lib/items.mjs.
import { runIfMain } from './lib/items.mjs';
import mcpShapeGuard, { WRAPPED } from './lib/mcp-shape-guard.mjs';

export const hooks = {
  pre: {
    tools: WRAPPED,
    run: mcpShapeGuard,
  },
};

await runIfMain(import.meta.url, 'mcp-shape-guard', { hooks });
