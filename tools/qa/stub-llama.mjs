/**
 * Stand-ins for everything llama.cpp touches, for checks and help shots — nothing here needs a GPU,
 * a multi-gigabyte file or the internet.
 *
 * 1. `ggufBuffer` / `writeGguf` — a header-only GGUF with the keys the panel reads
 *    (`general.architecture`, `<arch>.block_count`, `.attention.head_count_kv`, `.attention.key_length`,
 *    `.nextn_predict_layers`, `.full_attention_interval`) followed by a `tokenizer.*` key, exactly like
 *    real files order them. Extra padding makes sizes realistic where a test needs a size.
 * 2. `startStubLlama` — the HTTP surface of `llama-server` the panel uses, over a real socket:
 *    `/health` (503 while "loading"), `/props`, `/v1/messages/count_tokens`, `/v1/messages`,
 *    `/v1/chat/completions` with `timings`.
 * 3. `fakeNet` — a `fetch` that answers Hugging Face (tree + resolve with Range), and the GitHub release
 *    API with sha256 `digest` for the pinned llama.cpp tag, serving archives built by `zipBuffer`.
 *
 * Never touches the user's `~/.ollama`, `~/.claude` or a real llama.cpp install.
 */
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { deflateRawSync } from 'node:zlib';

const T_U32 = 4;
const T_STRING = 8;
const T_ARRAY = 9;

function str(value) {
  const bytes = Buffer.from(value, 'utf8');
  const len = Buffer.alloc(8);
  len.writeBigUInt64LE(BigInt(bytes.length));
  return Buffer.concat([len, bytes]);
}
function u32(value) {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(value);
  return b;
}
function kvString(key, value) {
  return Buffer.concat([str(key), u32(T_STRING), str(value)]);
}
function kvU32(key, value) {
  return Buffer.concat([str(key), u32(T_U32), u32(value)]);
}

/**
 * @param {{ arch?: string, layers?: number, kvHeads?: number, headDim?: number, nextn?: number,
 *           fullAttentionInterval?: number, contextLength?: number, padBytes?: number,
 *           tensors?: { name: string, dims: number[], type: number }[], fileType?: number, brokenVocabulary?: boolean, embeddingLength?: number, headCount?: number,
 *           experts?: number, expertsUsed?: number, omitKeyLength?: boolean, omitKvHeads?: boolean,
 *           ssm?: boolean }} [options]
 */
export function ggufBuffer(options = {}) {
  const arch = options.arch ?? 'qwen35';
  const pairs = [
    kvString('general.architecture', arch),
    ...(options.fileType === undefined ? [] : [kvU32('general.file_type', options.fileType)]),
    kvU32(`${arch}.block_count`, options.layers ?? 64),
    kvU32(`${arch}.context_length`, options.contextLength ?? 262144),
  ];
  if (!options.omitKvHeads)
    pairs.push(kvU32(`${arch}.attention.head_count_kv`, options.kvHeads ?? 4));
  if (!options.omitKeyLength)
    pairs.push(kvU32(`${arch}.attention.key_length`, options.headDim ?? 256));
  if (options.embeddingLength !== undefined)
    pairs.push(kvU32(`${arch}.embedding_length`, options.embeddingLength));
  if (options.headCount !== undefined)
    pairs.push(kvU32(`${arch}.attention.head_count`, options.headCount));
  if (options.experts !== undefined) pairs.push(kvU32(`${arch}.expert_count`, options.experts));
  if (options.expertsUsed !== undefined)
    pairs.push(kvU32(`${arch}.expert_used_count`, options.expertsUsed));
  if (options.nextn !== undefined) pairs.push(kvU32(`${arch}.nextn_predict_layers`, options.nextn));
  if (options.ssm) pairs.push(kvU32(`${arch}.ssm.conv_kernel`, 4));
  if (options.fullAttentionInterval !== undefined)
    pairs.push(kvU32(`${arch}.full_attention_interval`, options.fullAttentionInterval));
  // The vocabulary comes after every architecture key; the reader must stop here.
  // `brokenVocabulary` stands in for the megabytes of real tokens: a value of a type no reader knows, so a
  // reader that does not stop at `tokenizer.*` fails on it instead of passing by luck.
  pairs.push(
    options.brokenVocabulary
      ? Buffer.concat([str('tokenizer.ggml.tokens'), u32(99), Buffer.alloc(64, 1)])
      : Buffer.concat([
          str('tokenizer.ggml.tokens'),
          u32(T_ARRAY),
          u32(T_STRING),
          (() => {
            const count = Buffer.alloc(8);
            count.writeBigUInt64LE(2n);
            return Buffer.concat([count, str('a'), str('b')]);
          })(),
        ]),
  );
  const head = Buffer.alloc(24);
  head.write('GGUF', 0, 'latin1');
  head.writeUInt32LE(3, 4);
  const tensors = options.tensors ?? [];
  head.writeBigUInt64LE(BigInt(tensors.length), 8);
  head.writeBigUInt64LE(BigInt(pairs.length), 16);
  // Tensor table after the key/values: name, dims, ggml type, data offset.
  const infos = tensors.map((tensor) => {
    const dims = Buffer.alloc(8 * tensor.dims.length);
    tensor.dims.forEach((dim, i) => dims.writeBigUInt64LE(BigInt(dim), i * 8));
    const offset = Buffer.alloc(8);
    return Buffer.concat([
      str(tensor.name),
      u32(tensor.dims.length),
      dims,
      u32(tensor.type),
      offset,
    ]);
  });
  return Buffer.concat([head, ...pairs, ...infos, Buffer.alloc(options.padBytes ?? 0, 7)]);
}

export function writeGguf(path, options) {
  mkdirSync(dirname(path), { recursive: true });
  const buffer = ggufBuffer(options);
  writeFileSync(path, buffer);
  return buffer;
}

export function sha256Of(buffer) {
  return createHash('sha256').update(buffer).digest('hex');
}

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let i = 0; i < 8; i += 1) crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/** A real zip (deflate), enough for `tar -xf` (bsdtar) to unpack: `files` = `{ 'dir/name': Buffer }`. */
export function zipBuffer(files) {
  const locals = [];
  const central = [];
  let offset = 0;
  for (const [name, data] of Object.entries(files)) {
    const nameBytes = Buffer.from(name, 'utf8');
    const packed = deflateRawSync(data);
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(8, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(packed.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    locals.push(local, nameBytes, packed);
    const entry = Buffer.alloc(46);
    entry.writeUInt32LE(0x02014b50, 0);
    entry.writeUInt16LE(20, 4);
    entry.writeUInt16LE(20, 6);
    entry.writeUInt16LE(8, 10);
    entry.writeUInt32LE(crc, 16);
    entry.writeUInt32LE(packed.length, 20);
    entry.writeUInt32LE(data.length, 24);
    entry.writeUInt16LE(nameBytes.length, 28);
    entry.writeUInt32LE(offset, 42);
    central.push(entry, nameBytes);
    offset += local.length + nameBytes.length + packed.length;
  }
  const centralBuffer = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(Object.keys(files).length, 8);
  end.writeUInt16LE(Object.keys(files).length, 10);
  end.writeUInt32LE(centralBuffer.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, centralBuffer, end]);
}

async function readBody(req) {
  let text = '';
  for await (const chunk of req) text += chunk;
  try {
    return text ? JSON.parse(text) : {};
  } catch {
    return {};
  }
}

/**
 * @param {{ port?: number, alias?: string, nCtx?: number, tokensPerSec?: number, loadingMs?: number,
 *           inputTokens?: number, sleeping?: boolean, countTools?: boolean, slotTokens?: number,
 *           slotDir?: string }} [options]
 */
export async function startStubLlama(options = {}) {
  const calls = [];
  const startedAt = Date.now();
  // Сон по простою (`--sleep-idle-seconds`): /health, /props, /v1/models не будят, всё остальное — будит, как у настоящего.
  const state = { sleeping: options.sleeping === true };
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://x');
    const json = (status, value) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(value));
    };
    const payload = req.method === 'GET' ? {} : await readBody(req);
    calls.push({ method: req.method, path: url.pathname, query: url.search, body: payload });
    const exempt = ['/health', '/props', '/v1/models'].includes(url.pathname);
    if (state.sleeping && !exempt) state.sleeping = false;
    if (url.pathname === '/health') {
      if (Date.now() - startedAt < (options.loadingMs ?? 0))
        return json(503, { error: { message: 'Loading model', code: 503 } });
      return json(200, { status: 'ok' });
    }
    if (url.pathname === '/props')
      return json(200, {
        build_info: 'b11583-stub',
        model_alias: options.alias ?? 'stub',
        is_sleeping: state.sleeping,
        default_generation_settings: { n_ctx: options.nCtx ?? 65536 },
      });
    if (url.pathname === '/slots/0' && url.searchParams.get('action') === 'erase')
      return json(200, { id_slot: 0, n_erased: 2038 });
    // Сохранение и восстановление кеша слота — ответы сборки b11583 (замер 15.10). Файлы
    // «пишутся» в память заглушки: восстановить можно только сохранённое ею же. С `slotDir`
    // (`--slot-save-path`) файл ложится и на диск, как у настоящего, — его видит панель.
    if (url.pathname === '/slots/0' && url.searchParams.get('action') === 'save') {
      state.savedSlots ??= new Set();
      state.savedSlots.add(payload.filename);
      if (options.slotDir) writeFileSync(join(options.slotDir, payload.filename), 'slot');
      return json(200, {
        id_slot: 0,
        filename: payload.filename,
        n_saved: options.slotTokens ?? 22358,
        n_written: 2262668504,
        timings: { save_ms: 1830 },
      });
    }
    if (url.pathname === '/slots/0' && url.searchParams.get('action') === 'restore') {
      const onDisk = options.slotDir && existsSync(join(options.slotDir, payload.filename));
      if (!state.savedSlots?.has(payload.filename) && !onDisk)
        return json(400, {
          error: { code: 400, message: 'failed to restore slot', type: 'invalid_request_error' },
        });
      return json(200, {
        id_slot: 0,
        filename: payload.filename,
        n_restored: options.slotTokens ?? 22358,
        n_read: 2262668504,
        timings: { restore_ms: 2224 },
      });
    }
    if (url.pathname === '/v1/messages/count_tokens')
      return json(200, {
        // `countTools`: инструменты запроса прибавляют токены (четверть длины JSON) — так видна цена набора.
        input_tokens:
          (options.inputTokens ?? 7768) +
          (options.countTools ? Math.ceil(JSON.stringify(payload.tools ?? []).length / 4) : 0),
      });
    if (url.pathname === '/v1/chat/completions') {
      const rate = options.tokensPerSec ?? 42;
      return json(200, {
        choices: [{ message: { role: 'assistant', content: 'function merge() {}' } }],
        timings: {
          prompt_n: 120,
          prompt_ms: 60,
          predicted_n: 256,
          predicted_ms: (256 / rate) * 1000,
        },
      });
    }
    if (url.pathname === '/v1/messages')
      return json(200, {
        id: 'msg_stub',
        type: 'message',
        role: 'assistant',
        model: payload.model ?? options.alias ?? 'stub',
        content: [{ type: 'text', text: 'ok' }],
        stop_reason: 'end_turn',
        usage: { input_tokens: 12, output_tokens: 2 },
      });
    return json(404, { error: { message: 'not found' } });
  });
  await new Promise((done) => server.listen(options.port ?? 0, '127.0.0.1', done));
  const address = server.address();
  return {
    port: typeof address === 'object' && address ? address.port : 0,
    calls,
    /** Уложить сервер спать, как по простою. */
    sleep: () => {
      state.sleeping = true;
    },
    isSleeping: () => state.sleeping,
    close: () =>
      new Promise((done) => {
        server.closeAllConnections?.();
        server.close(() => done(undefined));
      }),
  };
}

/**
 * Fake network for `fetchImpl`.
 *
 * @param {{ repos?: Record<string, Record<string, Buffer | { data: Buffer, noLfs?: boolean }>>,
 *           release?: { repo: string, tag: string, assets: Record<string, Buffer>, noDigest?: boolean },
 *           cards?: Record<string, unknown>, status?: Record<string, number>, ignoreRange?: boolean,
 *           cutAfter?: number }} spec
 */
export function fakeNet(spec) {
  const requests = [];
  const fetchImpl = async (input, init = {}) => {
    const url = String(input);
    requests.push({ url, range: init.headers?.range });
    for (const [prefix, status] of Object.entries(spec.status ?? {}))
      if (url.includes(prefix)) return new Response('', { status });
    const tree = /^https:\/\/huggingface\.co\/api\/models\/([^/]+\/[^/]+)\/tree\/main$/.exec(url);
    if (tree) {
      const files = spec.repos?.[tree[1]];
      if (!files) return new Response('', { status: 404 });
      return Response.json(
        Object.entries(files).map(([path, entry]) => {
          const data = Buffer.isBuffer(entry) ? entry : entry.data;
          const noLfs = !Buffer.isBuffer(entry) && entry.noLfs;
          return noLfs
            ? { type: 'file', path, size: data.length }
            : { type: 'file', path, size: 135, lfs: { oid: sha256Of(data), size: data.length } };
        }),
      );
    }
    const card = /^https:\/\/huggingface\.co\/api\/models\/([^/]+\/[^/]+)$/.exec(url);
    if (card) {
      const info = spec.cards?.[card[1]];
      return info ? Response.json(info) : new Response('', { status: 404 });
    }
    const resolve = /^https:\/\/huggingface\.co\/([^/]+\/[^/]+)\/resolve\/main\/(.+)$/.exec(url);
    if (resolve) {
      const entry = spec.repos?.[resolve[1]]?.[resolve[2]];
      if (!entry) return new Response('', { status: 404 });
      return bytes(Buffer.isBuffer(entry) ? entry : entry.data, init, spec);
    }
    if (
      spec.release &&
      url === `https://api.github.com/repos/${spec.release.repo}/releases/tags/${spec.release.tag}`
    ) {
      return Response.json({
        tag_name: spec.release.tag,
        assets: Object.entries(spec.release.assets).map(([name, data]) => ({
          name,
          size: data.length,
          browser_download_url: `https://github.example/${spec.release.tag}/${name}`,
          digest: spec.release.noDigest ? null : `sha256:${sha256Of(data)}`,
        })),
      });
    }
    const asset = spec.release && /^https:\/\/github\.example\/[^/]+\/(.+)$/.exec(url);
    if (asset && spec.release?.assets[asset[1]])
      return bytes(spec.release.assets[asset[1]], init, spec);
    return new Response('', { status: 404 });
  };
  return { fetchImpl, requests };
}

function bytes(data, init, spec) {
  const range = /^bytes=(\d+)-(\d*)$/.exec(init.headers?.range ?? '');
  const from = range && !spec.ignoreRange ? Number(range[1]) : 0;
  const to = range?.[2] && !spec.ignoreRange ? Number(range[2]) + 1 : data.length;
  let body = data.subarray(from, to);
  if (spec.cutAfter !== undefined && from === 0) body = body.subarray(0, spec.cutAfter);
  return new Response(body, {
    status: range && !spec.ignoreRange ? 206 : 200,
    headers: { 'content-length': String(body.length) },
  });
}

if (
  process.argv[1] &&
  import.meta.url.endsWith(process.argv[1].replaceAll('\\', '/').split('/').pop() ?? '')
) {
  const stub = await startStubLlama({ port: Number(process.argv[2] ?? 11435) });
  console.log(`stub llama-server on 127.0.0.1:${stub.port}`);
}
