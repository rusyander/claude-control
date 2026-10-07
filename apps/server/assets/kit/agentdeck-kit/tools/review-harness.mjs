#!/usr/bin/env node
// L3 stand for deep-review (live-proof.md): the reviewed tree stays untouched, faults are injected at
// the network boundary, every container carries `claude.ephemeral=review-<slug>` so `down` (or the
// ephemeral sweep) removes exactly what this review started.
//
//   clone  --repo <src> --sha <head> --to <dir>           detached scratch checkout (git clone --shared)
//   proxy up    --slug s --listen <port> --upstream <host:port> [--api 8474] [--image ..] [--dry-run]
//   proxy fault --slug s --kind latency|timeout|reset|slow-close|bandwidth|slicer|limit-data [--ms N] [--bytes N] [--upstream-side]
//   proxy reset --slug s                                  drop every toxic, re-enable the proxy
//   fake-upstream --port P --mode ok|sse-cut|sse-eof|sse-split|hang|slow-headers|status [--events N] [--after N] [--code C] [--slug s]
//   probe stream --url U [--method POST] [--body file] [--header 'k: v']... [--timeout ms] [--abort-after ms] [--terminal re]
//   fe-config --repo <root> --app <dir> --out <file>      vitest config: workspace packages → their source, not a stale dist
//   down --slug s [--dry-run]                             containers by label + fake-upstream pids from the state file
import { spawnSync, execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import path from 'node:path';
import os from 'node:os';

export const IMAGE = 'ghcr.io/shopify/toxiproxy:2.9.0';
const STATE_DIR = path.join(os.tmpdir(), 'review-harness');
const TOXIC = {
  latency: (o) => ({ type: 'latency', attributes: { latency: +(o.ms ?? 3000), jitter: 0 } }),
  timeout: (o) => ({ type: 'timeout', attributes: { timeout: +(o.ms ?? 0) } }), // 0 = hold forever
  reset: (o) => ({ type: 'reset_peer', attributes: { timeout: +(o.ms ?? 0) } }),
  'slow-close': (o) => ({ type: 'slow_close', attributes: { delay: +(o.ms ?? 5000) } }),
  bandwidth: (o) => ({ type: 'bandwidth', attributes: { rate: +(o.bytes ?? 1) } }), // KB/s
  slicer: (o) => ({
    type: 'slicer',
    attributes: { average_size: +(o.bytes ?? 3), size_variation: 1, delay: +(o.ms ?? 50) * 1000 },
  }),
  'limit-data': (o) => ({ type: 'limit_data', attributes: { bytes: +(o.bytes ?? 512) } }),
};

function args(argv) {
  const out = { _: [], header: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) {
      out._.push(a);
      continue;
    }
    const k = a.slice(2);
    const v = argv[i + 1] === undefined || argv[i + 1].startsWith('--') ? true : argv[++i];
    if (k === 'header') out.header.push(v);
    else out[k] = v;
  }
  return out;
}
const statePath = (slug) => path.join(STATE_DIR, `${slug}.json`);
export function readState(slug) {
  try {
    return JSON.parse(readFileSync(statePath(slug), 'utf8'));
  } catch {
    return { pids: [], containers: [] };
  }
}
function writeState(slug, s) {
  mkdirSync(STATE_DIR, { recursive: true });
  writeFileSync(statePath(slug), JSON.stringify(s, null, 1));
}
const label = (slug) => `claude.ephemeral=review-${slug}`;
const cname = (slug) => `review-${slug}-toxiproxy`;

export function clone({ repo, sha, to }) {
  const run = (...a) =>
    execFileSync('git', a, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  run('clone', '--quiet', '--shared', '--no-checkout', path.resolve(repo), to);
  // a Windows-reserved name in the tree (seen in a Go monorepo: shared/http/nul.go) is refused by protectNTFS and
  // aborts the whole checkout; let it through and report what the filesystem could not hold
  run('-C', to, '-c', 'core.protectNTFS=false', 'checkout', '--quiet', '--detach', sha);
  const unmaterialised = run('-C', to, 'status', '--porcelain')
    .split('\n')
    .filter(Boolean)
    .map((l) => l.slice(3));
  return { sha: run('-C', to, 'rev-parse', 'HEAD').trim(), unmaterialised };
}

export function proxyUpArgv({ slug, listen, api = 8474, image = IMAGE }) {
  return [
    'run',
    '-d',
    '--rm',
    '--name',
    cname(slug),
    '--label',
    label(slug),
    '-p',
    `127.0.0.1:${api}:8474`,
    '-p',
    `127.0.0.1:${listen}:${listen}`,
    '--add-host',
    'host.docker.internal:host-gateway',
    image,
  ];
}

export function toxiApi(apiPort, method, route, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : '';
    const req = http.request(
      {
        host: '127.0.0.1',
        port: apiPort,
        method,
        path: route,
        headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) },
      },
      (res) => {
        let t = '';
        res.on('data', (c) => (t += c));
        res.on('end', () =>
          res.statusCode < 300
            ? resolve(t ? JSON.parse(t) : {})
            : reject(new Error(`toxiproxy ${method} ${route} → ${res.statusCode} ${t}`)),
        );
      },
    );
    req.on('error', reject);
    req.end(data);
  });
}

export async function proxyFault({ slug, kind, api = 8474, ...o }) {
  const make = TOXIC[kind];
  if (!make) throw new Error(`kind: ${Object.keys(TOXIC).join('|')}`);
  const t = make(o);
  return toxiApi(+api, 'POST', `/proxies/${slug}/toxics`, {
    name: `${kind}-${Date.now()}`,
    stream: o['upstream-side'] ? 'upstream' : 'downstream',
    toxicity: 1,
    ...t,
  });
}

/** A controllable upstream: the shapes a stream breaks in, served on 127.0.0.1. */
export function fakeUpstream({
  port = 0,
  mode = 'ok',
  events = 5,
  after = 2,
  code = 503,
  delay = 200,
} = {}) {
  const ev = (i) => `event: delta\ndata: {"i":${i},"text":"step ${i} é"}\n\n`;
  const done = 'event: message_stop\ndata: [DONE]\n\n';
  const server = http.createServer((req, res) => {
    req.resume();
    if (mode === 'status') {
      res.writeHead(+code, { 'content-type': 'application/json' });
      return res.end(`{"error":"fake ${code}"}`);
    }
    const head = () =>
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
    if (mode === 'slow-headers')
      return setTimeout(() => {
        head();
        res.end(ev(0) + done);
      }, +delay);
    head();
    if (mode === 'hang') return res.flushHeaders();
    let i = 0;
    const tick = () => {
      if (mode === 'sse-cut' && i === +after) return res.socket.destroy();
      if (mode === 'sse-eof' && i === +after) return res.end(); // clean close, terminal event never sent
      if (i === +events) return res.end(done);
      if (mode === 'sse-split') {
        // cut inside the multibyte «é» and inside the frame: a reader that decodes per chunk or splits on
        // chunk edges shows mojibake or a lost event
        const b = Buffer.from(ev(i));
        const at = b.indexOf(Buffer.from('é')) + 1;
        res.write(b.subarray(0, at));
        return setTimeout(() => {
          res.write(b.subarray(at));
          i++;
          setTimeout(tick, 5);
        }, 20);
      }
      res.write(ev(i++));
      setTimeout(tick, 5);
    };
    tick();
  });
  return new Promise((resolve) => server.listen(+port, '127.0.0.1', () => resolve(server)));
}

/** Stream a response and report its shape: status, time to headers, chunks, events, how it ended. */
export function probe({
  url,
  method = 'GET',
  body,
  header = [],
  timeout = 30000,
  abortAfter,
  terminal = '\\[DONE\\]|message_stop',
}) {
  const t0 = Date.now();
  const u = new URL(url);
  const lib = u.protocol === 'https:' ? https : http;
  const headers = Object.fromEntries(
    header.map((h) => [h.slice(0, h.indexOf(':')).trim(), h.slice(h.indexOf(':') + 1).trim()]),
  );
  return new Promise((resolve) => {
    const r = {
      status: null,
      ttfbMs: null,
      chunks: 0,
      bytes: 0,
      events: 0,
      terminal: false,
      ended: null,
      ms: null,
      badUtf8: false,
    };
    const bufs = [];
    let settled = false;
    const finish = (how) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const text = Buffer.concat(bufs).toString('utf8');
      r.badUtf8 = text.includes('�');
      r.events = text.split(/\r?\n\r?\n/).filter((f) => /^data:/m.test(f)).length;
      r.terminal = new RegExp(terminal).test(text);
      r.ended = how === 'end' && !r.terminal && r.events ? 'eof-without-terminal' : how;
      r.ms = Date.now() - t0;
      resolve(r);
    };
    const req = lib.request(u, { method, headers }, (res) => {
      r.status = res.statusCode;
      r.ttfbMs = Date.now() - t0;
      res.on('data', (c) => {
        r.chunks++;
        r.bytes += c.length;
        bufs.push(c);
      });
      res.on('end', () => finish('end'));
      res.on('aborted', () => finish('reset'));
      res.on('error', () => finish('reset'));
      res.on('close', () => finish(res.complete ? 'end' : 'reset'));
    });
    const timer = setTimeout(() => {
      finish('timeout');
      req.destroy();
    }, +timeout);
    if (abortAfter)
      setTimeout(() => {
        finish('client-abort');
        req.destroy();
      }, +abortAfter);
    req.on('error', (e) =>
      finish(settled ? 'late' : r.status === null ? `error ${e.code ?? e.message}` : 'reset'),
    );
    req.end(body ? readFileSync(body) : undefined);
  });
}

function expand(root, pattern) {
  const clean = pattern
    .replace(/^['"]|['"]$/g, '')
    .replace(/^\.\//, '')
    .replace(/\/$/, '');
  if (clean.startsWith('!')) return [];
  if (!clean.includes('*')) return [path.join(root, clean)];
  const base = path.join(root, clean.slice(0, clean.indexOf('*')).replace(/\/$/, ''));
  if (!existsSync(base)) return [];
  return readdirSync(base)
    .map((d) => path.join(base, d))
    .filter((d) => statSync(d).isDirectory());
}
/** Workspace packages with a source entry: pnpm-workspace.yaml or package.json workspaces. */
export function workspacePackages(root) {
  let globs = [];
  const pnpm = path.join(root, 'pnpm-workspace.yaml');
  if (existsSync(pnpm))
    globs = [...readFileSync(pnpm, 'utf8').matchAll(/^\s*-\s*(.+?)\s*$/gm)].map((m) => m[1]);
  else {
    try {
      const ws = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')).workspaces;
      globs = Array.isArray(ws) ? ws : (ws?.packages ?? []);
    } catch {
      /* no workspace */
    }
  }
  const out = [];
  for (const dir of globs.flatMap((g) => expand(root, g))) {
    let pkg;
    try {
      pkg = JSON.parse(readFileSync(path.join(dir, 'package.json'), 'utf8'));
    } catch {
      continue;
    }
    const dot = pkg.exports?.['.'];
    const cands = [
      pkg.source,
      dot?.source,
      dot?.development,
      'src/index.ts',
      'src/index.tsx',
      'index.ts',
      'src/index.js',
    ].filter((c) => typeof c === 'string');
    const entry = cands
      .map((c) => path.join(dir, c))
      .find((p) => existsSync(p) && !/[\\/]dist[\\/]/.test(p));
    if (pkg.name && entry)
      out.push({
        name: pkg.name,
        dir,
        entry,
        src: existsSync(path.join(dir, 'src')) ? path.join(dir, 'src') : null,
      });
  }
  return out;
}

export function feConfig({ repo, app, out }) {
  const root = path.resolve(repo);
  const appDir = path.resolve(root, app);
  const base = [
    'vitest.config.ts',
    'vitest.config.mts',
    'vite.config.ts',
    'vite.config.mts',
    'vite.config.js',
  ].find((f) => existsSync(path.join(appDir, f)));
  const pkgs = workspacePackages(root);
  const slash = (p) => p.replace(/\\/g, '/');
  const esc = (s) => s.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
  const alias = pkgs.flatMap((p) => [
    `    { find: /^${esc(p.name)}$/, replacement: ${JSON.stringify(slash(p.entry))} },`,
    ...(p.src
      ? [
          `    { find: /^${esc(p.name)}\\/(.*)$/, replacement: ${JSON.stringify(slash(p.src) + '/$1')} },`,
        ]
      : []),
  ]);
  const rel = base
    ? slash(path.relative(path.dirname(path.resolve(out)), path.join(appDir, base)))
    : null;
  const text = [
    '// generated by review-harness fe-config: workspace packages resolve to source, so a stale dist cannot answer for the diff',
    "import { defineConfig, mergeConfig } from 'vitest/config'",
    ...(rel ? [`import base from ${JSON.stringify(rel.startsWith('.') ? rel : './' + rel)}`] : []),
    `const own = defineConfig({ root: ${JSON.stringify(slash(appDir))}, resolve: { alias: [`,
    ...alias,
    '  ] } })',
    rel
      ? "export default mergeConfig(typeof base === 'function' ? base({ mode: 'test', command: 'serve' }) : base, own)"
      : 'export default own',
    '',
  ].join('\n');
  writeFileSync(out, text);
  return { base: base ?? null, packages: pkgs.length };
}

export function down({ slug, dryRun }) {
  const s = readState(slug);
  const killed = [];
  for (const pid of s.pids) {
    try {
      if (!dryRun) process.kill(pid);
      killed.push(pid);
    } catch {
      /* already gone */
    }
  }
  const argv = ['ps', '-aq', '--filter', `label=${label(slug)}`];
  let ids = [];
  if (!dryRun) {
    const r = spawnSync('docker', argv, { encoding: 'utf8' });
    ids = r.status === 0 ? r.stdout.split('\n').filter(Boolean) : [];
    if (ids.length) spawnSync('docker', ['rm', '-f', ...ids], { encoding: 'utf8' });
    writeState(slug, { pids: [], containers: [] });
  }
  return { killed, containers: ids, docker: `docker ${argv.join(' ')} | xargs docker rm -f` };
}

async function main() {
  const [cmd, sub, ...rest] = process.argv.slice(2);
  const o = args(
    ['proxy', 'probe'].includes(cmd) ? rest : [sub, ...rest].filter((x) => x !== undefined),
  );
  const need = (...k) => {
    const miss = k.filter((x) => !o[x]);
    if (miss.length) throw new Error(`missing --${miss.join(' --')}`);
  };
  if (cmd === 'clone') {
    need('repo', 'sha', 'to');
    const r = clone(o);
    console.log(
      `clone ${o.to} at ${r.sha}${r.unmaterialised.length ? ` · not materialised on this filesystem (read via \`git show ${r.sha.slice(0, 9)}:<path>\`): ${r.unmaterialised.join(', ')}` : ''}`,
    );
    return 0;
  }
  if (cmd === 'proxy' && sub === 'up') {
    need('slug', 'listen', 'upstream');
    const argv = proxyUpArgv(o);
    if (o['dry-run']) {
      console.log(`docker ${argv.join(' ')}`);
      return 0;
    }
    const r = spawnSync('docker', argv, { encoding: 'utf8' });
    if (r.status) throw new Error(r.stderr.trim());
    const api = +(o.api ?? 8474);
    for (let i = 0; i < 40; i++) {
      try {
        await toxiApi(api, 'GET', '/version');
        break;
      } catch {
        await new Promise((z) => setTimeout(z, 250));
      }
    }
    const upstream = String(o.upstream).replace(
      /^(localhost|127\.0\.0\.1):/,
      'host.docker.internal:',
    );
    await toxiApi(api, 'POST', '/proxies', {
      name: o.slug,
      listen: `0.0.0.0:${o.listen}`,
      upstream,
      enabled: true,
    });
    const s = readState(o.slug);
    writeState(o.slug, { ...s, containers: [...s.containers, cname(o.slug)] });
    console.log(
      `proxy ${o.slug}: 127.0.0.1:${o.listen} → ${upstream} · api 127.0.0.1:${api} · label ${label(o.slug)}`,
    );
    return 0;
  }
  if (cmd === 'proxy' && sub === 'fault') {
    need('slug', 'kind');
    const t = await proxyFault(o);
    console.log(`toxic ${t.name} ${t.type} ${JSON.stringify(t.attributes)}`);
    return 0;
  }
  if (cmd === 'proxy' && sub === 'reset') {
    need('slug');
    await toxiApi(+(o.api ?? 8474), 'POST', '/reset');
    console.log('toxics cleared');
    return 0;
  }
  if (cmd === 'fake-upstream') {
    need('mode');
    const srv = await fakeUpstream(o);
    const port = srv.address().port;
    if (o.slug) {
      const s = readState(o.slug);
      writeState(o.slug, { ...s, pids: [...s.pids, process.pid] });
    }
    console.log(`fake-upstream ${o.mode} on 127.0.0.1:${port} pid ${process.pid}`);
    return new Promise(() => {}); // serve until killed (down --slug, or the background task's stop)
  }
  if (cmd === 'probe' && sub === 'stream') {
    need('url');
    console.log(JSON.stringify(await probe({ ...o, abortAfter: o['abort-after'] })));
    return 0;
  }
  if (cmd === 'fe-config') {
    need('repo', 'app', 'out');
    const r = feConfig(o);
    console.log(
      `${o.out}: ${r.packages} workspace packages → source; base ${r.base ?? 'none'}. Run: npx vitest --config ${o.out}`,
    );
    return 0;
  }
  if (cmd === 'down') {
    need('slug');
    const r = down({ slug: o.slug, dryRun: o['dry-run'] });
    console.log(
      `${o['dry-run'] ? 'would kill' : 'killed'} pids [${r.killed.join(', ')}] · containers ${o['dry-run'] ? r.docker : `[${r.containers.join(', ')}]`}`,
    );
    return 0;
  }
  console.error(
    'usage: review-harness.mjs clone|proxy up|proxy fault|proxy reset|fake-upstream|probe stream|fe-config|down — see header',
  );
  return 2;
}

if (process.argv[1]?.endsWith('review-harness.mjs')) {
  main().then(
    (c) => {
      if (c !== undefined) process.exitCode = c;
    },
    (e) => {
      console.error(`review-harness: ${e.message}`);
      process.exitCode = 2;
    },
  );
}
