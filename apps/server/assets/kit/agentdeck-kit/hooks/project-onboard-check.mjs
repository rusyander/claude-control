#!/usr/bin/env node
// At session start in a project with no agent context, points at the project-onboard skill.
// Kit hook item: run by the event dispatcher (lib/run.mjs) or on its own; see lib/items.mjs.
import projectOnboardCheck from './lib/project-onboard-check.mjs';
import { runIfMain } from './lib/items.mjs';

export const hooks = { session: projectOnboardCheck };

await runIfMain(import.meta.url, 'project-onboard-check', { hooks });
