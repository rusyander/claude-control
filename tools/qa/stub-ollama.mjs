/**
 * Stub Ollama server for checks and help shots: the HTTP API the panel uses, over a real socket.
 *
 * Writes models like real Ollama does — `manifests/registry.ollama.ai/library/<name>/<tag>` plus
 * `blobs/sha256-<hex>` under the given models dir — so the panel's file-based listing sees exactly
 * what a real pull leaves. No weights: each layer is a few bytes, sizes in the manifest are the
 * catalog's. Never touches the user's `~/.ollama`.
 *
 * Usage: `const stub = await startStubOllama({ modelsDir, port: 0 })`; `stub.port`, `stub.calls`,
 * `stub.close()`. Run standalone: `node tools/qa/stub-ollama.mjs <modelsDir> [port]`.
 */
import { createServer } from 'node:http';
import { mkdirSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createHash } from 'node:crypto';

const HOST = 'registry.ollama.ai';

export function manifestPath(modelsDir, tag) {
  const [name, version = 'latest'] = tag.split(':');
  const parts = name.split('/');
  const path = parts.length === 1 ? ['library', ...parts] : parts;
  return join(modelsDir, 'manifests', HOST, ...path, version);
}

function writeModel(modelsDir, tag, sizeBytes) {
  const digest = (seed) => `sha256:${createHash('sha256').update(seed).digest('hex')}`;
  const weights = digest(`${tag}-weights`);
  const config = digest(`${tag}-config`);
  mkdirSync(join(modelsDir, 'blobs'), { recursive: true });
  for (const d of [weights, config])
    writeFileSync(join(modelsDir, 'blobs', d.replace(':', '-')), tag);
  const manifest = {
    schemaVersion: 2,
    config: { digest: config, size: 500 },
    layers: [
      { mediaType: 'application/vnd.ollama.image.model', digest: weights, size: sizeBytes - 500 },
    ],
  };
  const file = manifestPath(modelsDir, tag);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(manifest));
  return { weights, config };
}

async function body(req) {
  let text = '';
  for await (const chunk of req) text += chunk;
  try {
    return text ? JSON.parse(text) : {};
  } catch {
    return {};
  }
}

/**
 * @param {{ modelsDir: string, port?: number, version?: string, sizes?: Record<string, number>,
 *           pullDelayMs?: number, failPull?: string, tokensPerSec?: number }} options
 */
export async function startStubOllama(options) {
  const calls = [];
  const loaded = new Map();
  const version = options.version ?? '0.35.1';
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://x');
    const json = (status, value) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(value));
    };
    const payload = req.method === 'GET' ? {} : await body(req);
    calls.push({ method: req.method, path: url.pathname, body: payload });
    if (url.pathname === '/api/version') return json(200, { version });
    if (url.pathname === '/api/ps') {
      return json(200, {
        models: [...loaded.entries()].map(([name, size]) => ({
          name,
          size_vram: size,
          expires_at: '2099-01-01T00:00:00Z',
        })),
      });
    }
    if (url.pathname === '/api/tags') return json(200, { models: [] });
    if (url.pathname === '/api/pull') {
      const tag = String(payload.model ?? '');
      if (options.failPull === tag)
        return json(500, { error: `pull model manifest: file does not exist` });
      const size = options.sizes?.[tag] ?? 1_000_000_000;
      res.writeHead(200, { 'content-type': 'application/x-ndjson' });
      const line = (value) => res.write(`${JSON.stringify(value)}\n`);
      line({ status: 'pulling manifest' });
      const digest = `sha256:${createHash('sha256').update(`${tag}-weights`).digest('hex')}`;
      const steps = 4;
      for (let i = 1; i <= steps; i += 1) {
        await new Promise((done) => setTimeout(done, options.pullDelayMs ?? 20));
        if (res.destroyed) return undefined;
        line({
          status: `pulling ${digest.slice(7, 19)}`,
          digest,
          total: size,
          completed: Math.round((size * i) / steps),
        });
      }
      line({ status: 'verifying sha256 digest' });
      line({ status: 'writing manifest' });
      writeModel(options.modelsDir, tag, size);
      line({ status: 'success' });
      return res.end();
    }
    if (url.pathname === '/api/delete') {
      const file = manifestPath(options.modelsDir, String(payload.model ?? ''));
      if (!existsSync(file)) return json(404, { error: 'model not found' });
      rmSync(file, { force: true });
      return json(200, {});
    }
    if (url.pathname === '/api/generate') {
      const tag = String(payload.model ?? '');
      if (payload.keep_alive === 0) {
        loaded.delete(tag);
        return json(200, { done: true });
      }
      if (!existsSync(manifestPath(options.modelsDir, tag)))
        return json(404, { error: `model "${tag}" not found` });
      loaded.set(tag, options.sizes?.[tag] ?? 1_000_000_000);
      const rate = options.tokensPerSec ?? 42;
      return json(200, {
        done: true,
        eval_count: 256,
        eval_duration: Math.round((256 / rate) * 1e9),
        prompt_eval_count: 120,
        prompt_eval_duration: 60_000_000,
      });
    }
    return json(404, { error: 'not found' });
  });
  await new Promise((done) => server.listen(options.port ?? 0, '127.0.0.1', done));
  const address = server.address();
  return {
    port: typeof address === 'object' && address ? address.port : 0,
    calls,
    loaded,
    writeModel: (tag, size) => writeModel(options.modelsDir, tag, size),
    close: () => new Promise((done) => server.close(() => done(undefined))),
  };
}

if (
  process.argv[1] &&
  import.meta.url.endsWith(process.argv[1].replaceAll('\\', '/').split('/').pop() ?? '')
) {
  const [modelsDir, port] = process.argv.slice(2);
  if (!modelsDir) {
    console.error('usage: node tools/qa/stub-ollama.mjs <modelsDir> [port]');
    process.exit(2);
  }
  const stub = await startStubOllama({ modelsDir, port: Number(port ?? 11435), pullDelayMs: 400 });
  console.log(`stub ollama on 127.0.0.1:${stub.port}, models in ${modelsDir}`);
}
