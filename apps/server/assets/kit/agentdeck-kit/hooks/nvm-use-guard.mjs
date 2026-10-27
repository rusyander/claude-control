#!/usr/bin/env node
// Windows with nvm-windows: `nvm use|on|off` is refused — it deletes the machine-wide Node junction and cannot recreate it without elevation; one command on another version gets a PATH prefix instead.
// Kit hook item: run by the event dispatcher (lib/run.mjs) or on its own; see lib/items.mjs.
import { runIfMain, TOOLS } from './lib/items.mjs';
import nvmUseGuard from './lib/nvm-use-guard.mjs';

export const hooks = {
  pre: {
    tools: TOOLS.BASH,
    run: (input) => nvmUseGuard(input),
  },
};

await runIfMain(import.meta.url, 'nvm-use-guard', { hooks });
