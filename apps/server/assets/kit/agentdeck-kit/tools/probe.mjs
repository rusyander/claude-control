/**
 * Persistent browser for live probes: the browser starts once, every probe gets a FRESH context.
 *
 * Why: a review ran 7 probes at 57-70 s each, every one relaunching Chromium and logging in again,
 * and each probe script printed whatever it pleased (one session: 261 heredoc probes, 502k chars of
 * output). Here the browser outlives the probe, the login is a saved storageState, and only what the
 * probe RETURNS is printed.
 *
 * Isolation: nothing is shared between probes except the storageState file named on the command line —
 * cookies, localStorage, routes and handlers die with the probe's context.
 *
 * Probe file: `export default async ({ page, context, args }) => result` — `args` = the words after
 * `--`; the returned value is printed as JSON (cut at --max chars), timing goes to stderr.
 *
 * Usage:
 *   node probe.mjs run <probe.mjs> [--state auth.json] [--save-state auth.json] [--viewport 1280x800]
 *                                  [--timeout 60] [--max 4000] [--headed] [-- args…]
 *   node probe.mjs status | stop
 * The browser closes itself after PROBE_IDLE_MIN minutes without a probe (default 15); `stop` at the end
 * of the task is still the plan — the idle timer is the backstop.
 *
 * Deps: playwright, resolved from the current project first (same browser build as its own runs), then
 * from this folder. One browser per playwright install: two projects never share one.
 */
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const SELF = fileURLToPath(import.meta.url);
const DIR = process.env.PROBE_DIR || join(tmpdir(), 'agentdeck-probe');
const IDLE_MS = Number(process.env.PROBE_IDLE_MIN ?? 15) * 60_000;

const argv = process.argv.slice(2);
const dashes = argv.indexOf('--');
const own = dashes === -1 ? argv : argv.slice(0, dashes);
const probeArgs = dashes === -1 ? [] : argv.slice(dashes + 1);
const flag = (name) => {
  const at = own.indexOf(`--${name}`);
  return at === -1 ? undefined : own[at + 1];
};
const has = (name) => own.includes(`--${name}`);

function playwrightPath() {
  for (const from of [join(process.cwd(), 'x.js'), join(HERE, 'x.js')]) {
    try {
      return createRequire(from).resolve('playwright');
    } catch {
      /* next candidate */
    }
  }
  return null;
}

async function loadPlaywright(path) {
  // playwright is CommonJS: named exports are not guaranteed, `default` is.
  const module = await import(pathToFileURL(path).href);
  return module.chromium ? module : module.default;
}

/** One state file per playwright install (and headed/headless): its browser server's endpoint. */
const stateFile = (path, headed) =>
  join(DIR, `${createHash('sha1').update(`${path}|${headed}`).digest('hex').slice(0, 12)}.json`);
const touchFile = (file) => `${file}.touch`;
const readState = (file) => {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
};
const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

/** Detached server: launches the browser, publishes the endpoint, exits after the idle limit. */
async function serve(path, headed) {
  const file = stateFile(path, headed);
  const { chromium } = await loadPlaywright(path);
  const server = await chromium.launchServer({ headless: !headed });
  writeFileSync(touchFile(file), '');
  writeFileSync(
    file,
    JSON.stringify({ ws: server.wsEndpoint(), pid: process.pid, path, headed, since: Date.now() }),
  );
  const close = async () => {
    rmSync(file, { force: true });
    rmSync(touchFile(file), { force: true });
    await server.close().catch(() => {});
    process.exit(0);
  };
  process.on('SIGTERM', close);
  process.on('SIGINT', close);
  for (;;) {
    await sleep(Math.min(30_000, IDLE_MS / 4));
    const owner = readState(file);
    if (owner?.pid !== process.pid) return close(); // replaced or stopped
    let last = 0;
    try {
      last = statSync(touchFile(file)).mtimeMs;
    } catch {
      /* gone → idle */
    }
    if (Date.now() - last > IDLE_MS) return close();
  }
}

/** The running browser's endpoint, starting one when there is none. Cold start → `cold: true`. */
async function endpoint(path, headed) {
  mkdirSync(DIR, { recursive: true });
  const file = stateFile(path, headed);
  const known = readState(file);
  if (known && alive(known.pid)) return { ws: known.ws, cold: false, file };
  rmSync(file, { force: true });
  const child = spawn(process.execPath, [SELF, 'serve', ...(headed ? ['--headed'] : [])], {
    cwd: process.cwd(),
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
  });
  child.unref();
  for (let waited = 0; waited < 30_000; waited += 100) {
    await sleep(100);
    const state = readState(file);
    if (state?.pid === child.pid) return { ws: state.ws, cold: true, file };
  }
  throw new Error('probe: the browser server did not start within 30 s');
}

const clip = (text, max) =>
  text.length <= max
    ? text
    : `${text.slice(0, max)}… [cut: ${text.length} chars, raise --max or return less]`;

async function run(path, headed) {
  const target = own[1];
  if (!target || !existsSync(resolve(target))) {
    console.error('probe: pass the probe file — node probe.mjs run <probe.mjs>');
    return 2;
  }
  const started = Date.now();
  const { chromium } = await loadPlaywright(path);
  const { ws, cold, file } = await endpoint(path, headed);
  writeFileSync(touchFile(file), '');
  const browser = await chromium.connect(ws);
  const [width, height] = String(flag('viewport') ?? '1280x800')
    .split('x')
    .map(Number);
  const statePath = flag('state');
  const context = await browser.newContext({
    viewport: { width, height },
    ...(statePath && existsSync(statePath) ? { storageState: statePath } : {}),
  });
  const page = await context.newPage();
  const timeoutS = Number(flag('timeout') ?? 60);
  let code = 0;
  try {
    const probe = (await import(pathToFileURL(resolve(target)).href)).default;
    if (typeof probe !== 'function')
      throw new Error('the probe file has no default export function');
    let timer;
    const result = await Promise.race([
      probe({ page, context, args: probeArgs }),
      new Promise((_, fail) => {
        timer = setTimeout(
          () => fail(new Error(`probe timed out after ${timeoutS} s`)),
          timeoutS * 1000,
        );
      }),
    ]).finally(() => clearTimeout(timer));
    if (flag('save-state')) await context.storageState({ path: flag('save-state') });
    if (result !== undefined)
      console.log(clip(JSON.stringify(result, null, 1), Number(flag('max') ?? 4000)));
  } catch (error) {
    console.error(`probe failed: ${error instanceof Error ? error.message : String(error)}`);
    code = 1;
  } finally {
    await context.close().catch(() => {});
    await browser.close().catch(() => {}); // disconnects; the server keeps the browser
    writeFileSync(touchFile(file), '');
  }
  console.error(`probe: ${Date.now() - started} ms (browser ${cold ? 'cold' : 'warm'})`);
  return code;
}

async function main() {
  const command = own[0];
  const headed = has('headed');
  const path = playwrightPath();
  if (!path) {
    console.error('probe: playwright not found — run from a project where it is installed');
    return 2;
  }
  if (command === 'serve') return serve(path, headed);
  if (command === 'run') return run(path, headed);
  if (command === 'status' || command === 'stop') {
    let found = 0;
    for (const mode of [false, true]) {
      const file = stateFile(path, mode);
      const state = readState(file);
      if (!state) continue;
      if (!alive(state.pid)) {
        rmSync(file, { force: true });
        continue;
      }
      found += 1;
      if (command === 'stop') {
        process.kill(state.pid, 'SIGTERM');
        for (let i = 0; i < 50 && alive(state.pid); i += 1) await sleep(100);
        if (alive(state.pid)) process.kill(state.pid, 'SIGKILL');
        rmSync(file, { force: true });
        console.log(`stopped browser server pid ${state.pid}${mode ? ' (headed)' : ''}`);
      } else {
        console.log(
          `running: pid ${state.pid}${mode ? ' (headed)' : ''}, up ${Math.round((Date.now() - state.since) / 1000)} s`,
        );
      }
    }
    if (!found) console.log('no browser server running for this playwright');
    return 0;
  }
  console.error(
    'usage: node probe.mjs run <probe.mjs> [--state f] [--save-state f] [-- args] | status | stop',
  );
  return 2;
}

process.exitCode = await main();
