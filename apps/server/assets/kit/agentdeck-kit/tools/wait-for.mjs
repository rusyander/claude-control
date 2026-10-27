#!/usr/bin/env node
/**
 * Wait until a port or URL answers — bounded, one call, exit code = the answer.
 *
 * Why: a split group started and killed its dev server five times in one delivery stage (g9 26.10),
 * each start followed by `for i in $(seq 1 60); do curl …; sleep 0.5; done` — a hand loop per start,
 * no verdict when it ran out. Here: the server is started ONCE in the background and this waits for it.
 *
 * Usage: node wait-for.mjs <port | host:port | http(s)://url> [--timeout 60] [--interval 0.5]
 *   port / host:port → a TCP connect succeeds (host defaults to 127.0.0.1, then ::1)
 *   url              → any HTTP response (a 404 is a server that is up; status printed)
 * Exit 0 = up (prints `up <target> after N s`), 1 = timeout (prints the last error), 2 = bad usage.
 * --timeout is capped at 600 s (the shell tool's own cap).
 */
import { connect } from 'node:net';

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  if (i < 0) return fallback;
  const v = Number(args.splice(i, 2)[1]);
  return Number.isFinite(v) && v > 0 ? v : fallback;
};
const timeoutS = Math.min(flag('timeout', 60), 600);
const intervalS = flag('interval', 0.5);
const target = args.find((a) => !a.startsWith('--'));
if (!target) {
  console.error(
    'usage: node wait-for.mjs <port | host:port | url> [--timeout 60] [--interval 0.5]',
  );
  process.exit(2);
}

const isUrl = /^https?:\/\//i.test(target);
const hp = /^(?:(.+):)?(\d{1,5})$/.exec(target);
if (!isUrl && !hp) {
  console.error(`wait-for: "${target}" is neither a port, host:port nor an http(s) URL`);
  process.exit(2);
}
const hosts = hp?.[1] ? [hp[1].replace(/^\[|\]$/g, '')] : ['127.0.0.1', '::1'];
const port = hp ? Number(hp[2]) : 0;

/** One TCP connect to `host`; resolves '' on success, the error text otherwise. */
const tcpTo = (host) =>
  new Promise((done) => {
    const s = connect({ host, port });
    const fail = (e) => {
      s.destroy();
      done(`${host}:${port} ${e?.code ?? e?.message ?? 'no answer'}`);
    };
    s.setTimeout(2_000, () => fail(new Error('connect timeout')));
    s.once('connect', () => {
      s.end();
      done('');
    });
    s.once('error', fail);
  });

/** One attempt over every host; '' when one answered, else the last error. */
async function tcpOnce() {
  let err = '';
  for (const host of hosts) {
    err = await tcpTo(host);
    if (err === '') return '';
  }
  return err;
}

/** One HTTP attempt; resolves `{ status }` on any response, `{ error }` otherwise. */
async function httpOnce() {
  try {
    const res = await fetch(target, { redirect: 'manual', signal: AbortSignal.timeout(5_000) });
    await res.body?.cancel();
    return { status: res.status };
  } catch (e) {
    return { error: String(e?.cause?.code ?? e?.cause?.message ?? e?.message ?? e) };
  }
}

const started = Date.now();
const deadline = started + timeoutS * 1000;
let last;
for (;;) {
  if (isUrl) {
    const r = await httpOnce();
    if (r.status !== undefined) {
      console.log(
        `up ${target} after ${((Date.now() - started) / 1000).toFixed(1)} s (HTTP ${r.status})`,
      );
      process.exit(0);
    }
    last = r.error;
  } else {
    const err = await tcpOnce();
    if (err === '') {
      console.log(`up ${target} after ${((Date.now() - started) / 1000).toFixed(1)} s`);
      process.exit(0);
    }
    last = err;
  }
  if (Date.now() + intervalS * 1000 > deadline) break;
  await new Promise((r) => setTimeout(r, intervalS * 1000));
}
console.error(`wait-for: timeout after ${timeoutS} s — ${target} not answering (last: ${last})`);
process.exit(1);
