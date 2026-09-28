#!/usr/bin/env node
// Fake `npx` / `python` for the panel's autotest run: the process the panel really spawns
// through the shell, standing in for Playwright / Cypress / pytest. It writes the junit
// report where the framework would (PLAYWRIGHT_JUNIT_OUTPUT_FILE, mochaFile=, --junitxml=)
// and exits non-zero on a red test, exactly like the real runners.
// FAKE_E2E_MODE: report (default) | none (exit 2, no report) | missing (npx refusal) |
// hang (wait for kill) |
// report-hang (write the report, then wait for kill — a run stopped after its results).
// FAKE_E2E_JUNIT: report body. FAKE_E2E_ARGV: file to dump argv + cwd + stand env into.
// Like the real Playwright junit reporter, retry children (<flakyFailure>, <flakyError>,
// <rerunFailure>, <rerunError>) reach the report only with PLAYWRIGHT_JUNIT_INCLUDE_RETRIES.
/* global process, setTimeout */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

const argv = process.argv.slice(2);
const mode = process.env.FAKE_E2E_MODE || 'report';
if (process.env.FAKE_E2E_ARGV) {
  writeFileSync(
    process.env.FAKE_E2E_ARGV,
    JSON.stringify({
      argv,
      cwd: process.cwd(),
      baseUrl: process.env.E2E_BASE_URL ?? null,
      secret: process.env.E2E_SECRET_TOKEN ?? null,
      includeRetries: process.env.PLAYWRIGHT_JUNIT_INCLUDE_RETRIES ?? null,
    }),
  );
}

function reportPath() {
  if (process.env.PLAYWRIGHT_JUNIT_OUTPUT_FILE) return process.env.PLAYWRIGHT_JUNIT_OUTPUT_FILE;
  for (const arg of argv) {
    const mocha = arg.match(/^mochaFile=(.+)$/);
    if (mocha) return mocha[1];
    const py = arg.match(/^--junitxml=(.+)$/);
    if (py) return py[1];
  }
  return undefined;
}

process.stdout.write(`fake runner: ${argv.join(' ')}\n`);
if (process.env.E2E_SECRET_TOKEN) process.stdout.write(`token ${process.env.E2E_SECRET_TOKEN}\n`);

if (mode === 'hang') {
  setTimeout(() => process.exit(0), 60_000);
} else if (mode === 'missing') {
  // What `npx --no-install` prints when the package is absent (npm 10/11).
  process.stderr.write(
    'npm error npx canceled due to missing packages and no YES option: ["playwright@1.61.1"]\n',
  );
  process.exit(1);
} else if (mode === 'none') {
  process.stderr.write('runner not installed\n');
  process.exit(2);
} else {
  const file = reportPath();
  if (!file) {
    process.stderr.write('no report path given\n');
    process.exit(3);
  }
  mkdirSync(dirname(file), { recursive: true });
  const body = process.env.FAKE_E2E_JUNIT || '<testsuites/>';
  const retries =
    !process.env.PLAYWRIGHT_JUNIT_OUTPUT_FILE ||
    process.env.PLAYWRIGHT_JUNIT_INCLUDE_RETRIES === '1';
  const retryTags = /<(flaky|rerun)(Failure|Error)\b[\s\S]*?(<\/\1\2>|\/>)/g;
  writeFileSync(file, retries ? body : body.replace(retryTags, ''));
  if (mode === 'report-hang') setTimeout(() => process.exit(0), 60_000);
  else process.exit(Number(process.env.FAKE_E2E_EXIT || 1));
}
