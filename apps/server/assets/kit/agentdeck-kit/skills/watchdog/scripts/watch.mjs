#!/usr/bin/env node
// Blocking live watch — one call per quiet stretch. Usage: node watch.mjs --help
import { runWatch } from './lib/run.mjs';

process.exitCode = await runWatch(process.argv.slice(2));
