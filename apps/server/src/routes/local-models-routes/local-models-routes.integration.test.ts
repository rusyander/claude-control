import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
  existsSync,
  statSync,
} from 'node:fs';
import { createServer } from 'node:net';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import type { LocalJob, LocalModelsInfo, LocalQuantsInfo } from '@agentdeck/contracts/local-models';
import type { ServerContext } from '../../context.ts';
import { createLocalModels, loadCatalog } from '../../domains/local-models/service.ts';
import { localPaths, readState, updateState } from '../../domains/local-models/paths.ts';
import { manifestPathOf, blobPathOf } from '../../domains/local-models/store.ts';
import { modelFilePath } from '../../domains/local-models/hf.ts';
import { loadRelease } from '../../domains/local-models/runtime.ts';
import { LOCAL_PLATFORM_ID } from '../../domains/local-models/connect.ts';
import { KitService } from '../../domains/kit/service.ts';
import { platformSchema } from '../../providers/settings-validation/settings-validation.ts';
import { registerLocalModelsRoutes } from './local-models-routes.ts';

/**
 * Весь путь раздела «Локальные модели» поверх настоящего сокета: настоящие
 * маршруты и сервис, вместо llama-server — заглушка `tools/qa/stub-llama.mjs`
 * (то же HTTP-лицо), вместо Hugging Face и GitHub — `fakeNet` с теми же ответами
 * (дерево, Range, digest). Ни гигабайтов, ни сети, ни видеокарты: железо
 * подставлено строкой nvidia-smi, процесс сервера — подменой запуска, которая
 * поднимает заглушку на порту из аргументов; снятие процесса закрывает её.
 */

interface StubLlama {
  port: number;
  calls: { method: string; path: string; body: unknown }[];
  close: () => Promise<void>;
}
interface Stubs {
  startStubLlama: (options: { port: number; tokensPerSec?: number }) => Promise<StubLlama>;
  ggufBuffer: (options?: Record<string, unknown>) => Buffer;
  fakeNet: (spec: Record<string, unknown>) => {
    fetchImpl: (url: string, init?: RequestInit) => Promise<Response>;
    requests: { url: string; range?: string }[];
  };
}

const REPO = resolve(import.meta.dirname, '..', '..', '..', '..', '..');
const TAG = 'qwen3.5:9b';
const IMPORT_TAG = 'qwen3.5:4b';
const BROKEN_TAG = 'broken:1b';

let stubs: Stubs;
let root: string;
let kit: KitService;
let app: FastifyInstance;
let base: string;
let port: number;
let weights: Buffer;
let server: StubLlama | undefined;
const spawned: { args: string[]; env: NodeJS.ProcessEnv }[] = [];
const killed: number[] = [];
const platformCalls: { method: string; url: string; body: unknown }[] = [];
const platforms = { activePlatformId: '', saved: undefined as Record<string, unknown> | undefined };
const netRequests: string[] = [];

const paths = (): ReturnType<typeof localPaths> =>
  localPaths(root, { AGENTDECK_LOCAL_MODELS_DIR: join(root, 'lm') });

async function api<T>(
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; body: T }> {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: body === undefined ? {} : { 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: response.status, body: (await response.json()) as T };
}

async function finished(id: string): Promise<LocalJob> {
  const deadline = Date.now() + 10_000;
  for (;;) {
    const { body } = await api<LocalModelsInfo>('GET', '/api/local-models');
    const job = body.jobs.find((item) => item.id === id);
    if (job && job.state !== 'running') return job;
    if (Date.now() > deadline) throw new Error(`job ${id} still running`);
    await new Promise((done) => setTimeout(done, 25));
  }
}

async function freeTcpPort(): Promise<number> {
  return new Promise((done, fail) => {
    const probe = createServer();
    probe.once('error', fail);
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address();
      const value = typeof address === 'object' && address ? address.port : 0;
      probe.close(() => done(value));
    });
  });
}

/** Системное хранилище Ollama с одной моделью: слой — GGUF под именем sha256-<хеш>. */
function writeOllamaModel(store: string, tag: string, blob: Buffer, digest: string): void {
  const manifest = manifestPathOf(store, tag);
  mkdirSync(join(manifest, '..'), { recursive: true });
  mkdirSync(join(store, 'blobs'), { recursive: true });
  writeFileSync(blobPathOf(store, `sha256:cfg-${digest}`), '{}');
  writeFileSync(blobPathOf(store, `sha256:${digest}`), blob);
  writeFileSync(
    manifest,
    JSON.stringify({
      config: { digest: `sha256:cfg-${digest}`, size: 2 },
      layers: [
        {
          mediaType: 'application/vnd.ollama.image.model',
          digest: `sha256:${digest}`,
          size: blob.length,
        },
      ],
    }),
  );
}

beforeAll(async () => {
  stubs = (await import(pathToFileURL(join(REPO, 'tools', 'qa', 'stub-llama.mjs')).href)) as Stubs;
  root = mkdtempSync(join(tmpdir(), 'cc-local-routes-'));
  const lm = join(root, 'lm');
  port = await freeTcpPort();

  // Своя сборка сервера «уже стоит»: каталог с файлом.
  const runtimeDir = join(paths().runtime, `llama-${loadRelease().tag}`);
  mkdirSync(runtimeDir, { recursive: true });
  writeFileSync(
    join(runtimeDir, process.platform === 'win32' ? 'llama-server.exe' : 'llama-server'),
    '',
  );

  // Репозиторий модели в «сети»: один файл нужного квантования и ещё одно квантование побольше.
  const model = loadCatalog().models.find((item) => item.tag === TAG);
  const quant = model?.quants.find((item) => item.id === model.defaultQuant);
  if (!model || !quant) throw new Error(`${TAG} not in catalog`);
  weights = stubs.ggufBuffer({ nextn: 0, padBytes: 8192 });
  const net = stubs.fakeNet({
    repos: {
      [model.repo]: {
        [quant.file]: weights,
        'Qwen3.5-9B-Q8_0.gguf': Buffer.alloc(weights.length * 2, 3),
        'mmproj-F16.gguf': Buffer.alloc(100, 1),
      },
    },
  });

  // Системная папка Ollama: одна модель открывается, одна — нет.
  const system = join(root, 'system-models');
  writeOllamaModel(system, IMPORT_TAG, stubs.ggufBuffer({ nextn: 1, padBytes: 256 }), 'w4');
  writeOllamaModel(system, BROKEN_TAG, stubs.ggufBuffer({ arch: 'exotic' }), 'wb');

  const env: NodeJS.ProcessEnv = {
    AGENTDECK_LOCAL_MODELS_DIR: lm,
    OLLAMA_MODELS: system,
    PATH: '',
    LOCALAPPDATA: join(root, 'appdata'),
    ProgramFiles: join(root, 'programs'),
    HOME: root,
    USERPROFILE: root,
  };
  const local = createLocalModels({
    appRoot: root,
    env,
    port,
    // Свой llama-server — настоящий сокет; всё остальное — сеть-заглушка.
    fetchImpl: (url, init) => {
      if (String(url).startsWith('http://127.0.0.1')) return fetch(url, init);
      netRequests.push(String(url));
      return net.fetchImpl(String(url), init);
    },
    run: async (cmd) => {
      if (cmd === 'nvidia-smi') return 'NVIDIA GeForce RTX 4090, 24564, 20000\n';
      throw new Error(`no ${cmd}`);
    },
    spawnServer: ((_binary: string, args: string[], options: { env: NodeJS.ProcessEnv }) => {
      spawned.push({ args, env: options.env });
      void stubs
        .startStubLlama({ port: Number(args[args.indexOf('--port') + 1]), tokensPerSec: 42 })
        .then((started) => {
          server = started;
        });
      return { pid: 999_000 + spawned.length, once: () => undefined, unref: () => undefined };
    }) as unknown as Parameters<typeof createLocalModels>[0]['spawnServer'],
    kill: (pid) => {
      killed.push(pid);
      void server?.close();
      server = undefined;
    },
    // Пробная загрузка: «экзотическую» архитектуру llama.cpp не открывает.
    testLoad: async (file) =>
      readFileSync(file).includes(Buffer.from('exotic'))
        ? { ok: false, reason: 'unknown model architecture' }
        : { ok: true },
    claude: {
      settingsPath: () => join(root, 'claude', 'settings.json'),
      backupDir: () => undefined,
    },
  });

  app = Fastify();
  // Маршруты контура — подделка, которая записывает, что ей прислали.
  app.get('/api/platforms', () => ({
    activePlatformId: platforms.activePlatformId,
    platforms: platforms.saved ? [{ platform: platforms.saved }] : [],
  }));
  app.put<{ Body: { settings: Record<string, unknown> } }>(
    '/api/platforms/:id',
    (request, reply) => {
      platformCalls.push({ method: 'PUT', url: request.url, body: request.body });
      // Тело — той же схемой, что у настоящего маршрута: заглушка, принимавшая
      // любое тело, держала зелёным подключение, которое настоящий контур отвергал.
      const parsed = platformSchema.safeParse(request.body.settings);
      if (!parsed.success) return reply.code(400).send({ code: 'invalid_body', message: 'схема' });
      platforms.saved = request.body.settings;
      return { ok: true };
    },
  );
  app.get('/api/platforms/:id/apply', () => ({
    consumers: [{ id: 'foreign:qwen' }, { id: 'foreign:codex', reason: 'нет' }],
  }));
  app.post<{ Body: unknown }>('/api/platforms/:id/apply', (request) => {
    platformCalls.push({ method: 'POST', url: request.url, body: request.body });
    return { applied: [{ targetId: 'assistant' }], skipped: [] };
  });
  app.post('/api/platforms/:id/activate', (request) => {
    platformCalls.push({ method: 'POST', url: request.url, body: undefined });
    platforms.activePlatformId = LOCAL_PLATFORM_ID;
    return { ok: true };
  });
  const ctx = { store: { getSettings: () => ({ remoteAccess: { enabled: false } }) } };
  kit = new KitService({
    appDataDir: join(root, 'app-data'),
    claudeDir: () => join(root, 'claude'),
    providers: () => [{ id: 'claude', name: 'Claude Code' }],
  });
  registerLocalModelsRoutes(app, ctx as unknown as ServerContext, local, kit);
  await app.listen({ port: 0, host: '127.0.0.1' });
  const address = app.server.address();
  base = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`;
});

afterAll(async () => {
  await app?.close();
  await server?.close();
  rmSync(root, { recursive: true, force: true });
});

describe('раздел «Локальные модели» по настоящему сокету', () => {
  it('снимок: карта, своя сборка, сервера нет, модели Ollama предлагаются к переносу', async () => {
    const { status, body } = await api<LocalModelsInfo>('GET', '/api/local-models');
    expect(status).toBe(200);
    expect(body.hardware.gpus[0]).toMatchObject({ name: 'NVIDIA GeForce RTX 4090', vramGb: 24 });
    expect(body.runtime).toMatchObject({ source: 'panel', version: 'b11583', outdated: false });
    expect(body.server).toMatchObject({ running: false, port });
    expect(body.installed).toEqual([]);
    expect(body.importable.map((item) => item.tag)).toEqual([BROKEN_TAG, IMPORT_TAG]);
    expect(body.connect).toEqual({ configured: false, active: false, model: '' });
    expect(body.catalog.models.every((model) => model.repo && model.quants.length > 0)).toBe(true);
  });

  it('незнакомый тег — 404 с кодом, а не загрузка чего попало; неверное квантование — тоже отказ', async () => {
    const { status, body } = await api<{ messageCode?: string; error: string }>(
      'POST',
      '/api/local-models/pull',
      { tag: 'evil:latest' },
    );
    expect(status).toBe(404);
    expect(body.messageCode).toBe('local-model-unknown');
    const quant = await api<{ messageCode?: string }>('POST', '/api/local-models/pull', {
      tag: TAG,
      quant: 'Q0_NOPE',
    });
    expect(quant.status).toBe(404);
    expect(quant.body.messageCode).toBe('local-quant-unknown');
    expect(netRequests.some((url) => url.includes('/resolve/'))).toBe(false);
  });

  it('квантования: живой список из репозитория, без проекторов; уместится ли на карту — по каждому', async () => {
    const { status, body } = await api<LocalQuantsInfo>(
      'GET',
      `/api/local-models/quants?tag=${encodeURIComponent(TAG)}`,
    );
    expect(status).toBe(200);
    expect(body).toMatchObject({ tag: TAG, from: 'hf', defaultQuant: 'Q4_K_M' });
    expect(body.rows.map((row) => row.id)).toEqual(['Q4_K_M', 'Q8_0']);
    expect(body.rows.every((row) => !row.installed && !row.active)).toBe(true);
    expect(body.rows[0]?.fit.level).toBe('gpu');
    const missing = await api('GET', '/api/local-models/quants?tag=nope:1b');
    expect(missing.status).toBe(404);
  });

  it('«Скачать и подключить»: прогресс по байтам, файл на диске, сервер поднят, контур заведён и включён', async () => {
    const started = await api<LocalJob>('POST', '/api/local-models/pull', {
      tag: TAG,
      connect: true,
    });
    expect(started.status).toBe(200);
    expect(started.body).toMatchObject({ kind: 'model', target: TAG, state: 'running' });
    const job = await finished(started.body.id);
    expect(job).toMatchObject({
      state: 'done',
      totalBytes: weights.length,
      doneBytes: weights.length,
    });
    const model = loadCatalog().models.find((item) => item.tag === TAG);
    const file = modelFilePath(paths(), model?.repo ?? '', 'Qwen3.5-9B-Q4_K_M.gguf');
    expect(readFileSync(file).equals(weights)).toBe(true);

    // Сервер поднят этой моделью: файл, имя, окно — аргументами запуска.
    expect(spawned).toHaveLength(1);
    const args = spawned[0]?.args ?? [];
    expect(args[args.indexOf('-m') + 1]).toBe(file);
    expect(args[args.indexOf('--alias') + 1]).toBe(TAG);
    expect(args).toContain('--jinja');
    expect(args).not.toContain('--spec-type');
    expect(args[args.indexOf('--port') + 1]).toBe(String(port));

    // Два PUT: первый с прогонами панели, второй ещё и с Qwen Code (контур его
    // принял), затем включение. Чужой CLI, которому контур отказал, не добавлен.
    const puts = platformCalls.filter((call) => call.method === 'PUT');
    expect(puts).toHaveLength(2);
    const settings = (puts[1]?.body as { settings: Record<string, unknown>; token: string })
      .settings;
    expect(settings).toMatchObject({
      id: LOCAL_PLATFORM_ID,
      driver: 'llama-cpp',
      baseUrl: `http://127.0.0.1:${port}/v1`,
      defaultModel: TAG,
      mode: 'required',
    });
    expect(settings.consumers).toContain('foreign:qwen');
    expect(settings.consumers).not.toContain('foreign:codex');
    // Включение, затем ассистент панели на контур: без него агент панели, помощники и
    // наблюдатель шли в облако Claude мимо локальной модели (живой прогон 08.10).
    expect(platformCalls.slice(-2)).toMatchObject([
      { method: 'POST', url: `/api/platforms/${LOCAL_PLATFORM_ID}/activate` },
      {
        method: 'POST',
        url: `/api/platforms/${LOCAL_PLATFORM_ID}/apply`,
        body: { targets: ['assistant'], overwrite: ['assistant'] },
      },
    ]);

    const { body } = await api<LocalModelsInfo>('GET', '/api/local-models');
    expect(body.connect).toEqual({ configured: true, active: true, model: TAG });
    expect(body.installed.map((item) => [item.tag, item.quant, item.source])).toEqual([
      [TAG, 'Q4_K_M', 'hf'],
    ]);
    expect(body.server).toMatchObject({ running: true, model: TAG, quant: 'Q4_K_M' });
    const quants = await api<LocalQuantsInfo>(
      'GET',
      `/api/local-models/quants?tag=${encodeURIComponent(TAG)}`,
    );
    expect(quants.body.rows.map((row) => [row.id, row.installed, row.active])).toEqual([
      ['Q4_K_M', true, true],
      ['Q8_0', false, false],
    ]);
  });

  it('замер: число из ответа сервера, сохранено в состоянии', async () => {
    const { status, body } = await api<{ tokensPerSec: number; gpu: string }>(
      'POST',
      '/api/local-models/bench',
      { tag: TAG },
    );
    expect(status).toBe(200);
    expect(body.tokensPerSec).toBe(42);
    expect(body.gpu).toBe('NVIDIA GeForce RTX 4090');
    const state = readState(paths());
    expect(state.bench[TAG]?.tokensPerSec).toBe(42);
    expect(state.bench[TAG]?.device).toBe('gpu');
    // Замер шёл на серверной заглушке, а не на втором запуске: процесс один.
    expect(spawned).toHaveLength(1);
  });

  it('замер на процессоре помечен процессором, а не именем карты', async () => {
    // Состояние «сервер уже перезапущен на процессоре»: смена устройства в этой
    // сборке недоступна — заглушке нельзя поднимать сервер, а смена обязана.
    const record = readFileSync(paths().pidFile, 'utf8');
    const setDevice = (device: 'cpu' | 'gpu', offload: string): void => {
      updateState(paths(), (state) => {
        state.device = device;
      });
      writeFileSync(paths().pidFile, JSON.stringify({ ...JSON.parse(record), device, offload }));
    };
    setDevice('cpu', 'none');
    try {
      const { body } = await api<{ gpu: string; device: string }>(
        'POST',
        '/api/local-models/bench',
        { tag: TAG },
      );
      expect(body).toMatchObject({ gpu: 'cpu', device: 'cpu' });
      expect(spawned).toHaveLength(1);
    } finally {
      setDevice('gpu', JSON.parse(record).offload);
      writeFileSync(paths().pidFile, record);
    }
  });

  it('перенос из системного Ollama — без второй копии на диске, MTP из заголовка', async () => {
    const started = await api<LocalJob>('POST', '/api/local-models/import', { tag: IMPORT_TAG });
    const job = await finished(started.body.id);
    expect(job.state).toBe('done');
    const target = join(paths().ollamaImport, 'qwen3.5-4b.gguf');
    expect(statSync(target).nlink).toBeGreaterThanOrEqual(2);
    const { body } = await api<LocalModelsInfo>('GET', '/api/local-models');
    expect(body.installed.find((item) => item.tag === IMPORT_TAG)).toMatchObject({
      quant: 'Ollama',
      source: 'ollama',
    });
    expect(body.importable.map((item) => item.tag)).toEqual([BROKEN_TAG]);
    expect(readState(paths()).imported[IMPORT_TAG]?.mtp).toBe(true);
  });

  it('модель, которую llama.cpp не открыл, — не в установленных, причина показана, предложение скачать заново', async () => {
    const started = await api<LocalJob>('POST', '/api/local-models/import', { tag: BROKEN_TAG });
    const job = await finished(started.body.id);
    expect(job).toMatchObject({ state: 'failed', errorCode: 'local-load-failed' });
    expect(existsSync(join(paths().ollamaImport, 'broken-1b.gguf'))).toBe(false);
    const { body } = await api<LocalModelsInfo>('GET', '/api/local-models');
    expect(body.installed.map((item) => item.tag)).not.toContain(BROKEN_TAG);
    expect(body.importable).toEqual([]);
    expect(body.importFailed).toEqual([
      { tag: BROKEN_TAG, reason: expect.stringContaining('unknown model architecture') },
    ]);
  });

  it('Claude Code на модели: галочка пишет settings.json, выключение возвращает прежнее', async () => {
    const settingsPath = join(root, 'claude', 'settings.json');
    mkdirSync(join(root, 'claude'), { recursive: true });
    const before = { model: 'opus', env: { DISABLE_TELEMETRY: '1' } };
    writeFileSync(settingsPath, JSON.stringify(before, null, 2));
    const file = (): { model?: string; env?: Record<string, string> } =>
      JSON.parse(readFileSync(settingsPath, 'utf8')) as { env?: Record<string, string> };

    const missing = await api<{ messageCode?: string }>('PUT', '/api/local-models/claude', {
      on: true,
      tag: 'nope:1b',
    });
    expect(missing.status).toBe(409);
    expect(missing.body.messageCode).toBe('local-model-missing');
    expect(file()).toEqual(before);
    expect((await api('PUT', '/api/local-models/claude', { on: 'yes' })).status).toBe(400);

    const on = await api<LocalModelsInfo['claude']>('PUT', '/api/local-models/claude', {
      on: true,
      tag: TAG,
    });
    expect(on.status).toBe(200);
    expect(on.body).toMatchObject({ on: true, model: TAG, settingsPath, drift: [] });
    const env = file().env ?? {};
    expect(env.ANTHROPIC_BASE_URL).toBe(`http://127.0.0.1:${port}`);
    expect(env.ANTHROPIC_MODEL).toBe(TAG);
    expect(env.ANTHROPIC_DEFAULT_OPUS_MODEL).toBe(TAG);
    expect(env.DISABLE_TELEMETRY).toBe('1');
    const snapshot = await api<LocalModelsInfo>('GET', '/api/local-models');
    expect(env.CLAUDE_CODE_MAX_CONTEXT_TOKENS).toBe(String(snapshot.body.server.context));
    expect(snapshot.body.claude.on).toBe(true);

    const off = await api<LocalModelsInfo['claude']>('PUT', '/api/local-models/claude', {
      on: false,
    });
    expect(off.body.on).toBe(false);
    expect(file()).toEqual(before);
  });

  it('устройство: неверное значение отклоняется, снимок называет выбранное', async () => {
    expect((await api('PUT', '/api/local-models/device', { device: 'tpu' })).status).toBe(400);
    const { body } = await api<LocalModelsInfo>('GET', '/api/local-models');
    expect(body.device).toBe('gpu');
  });

  it('модель, которую держит сервер, не удаляется (409), пока сервер не остановлен; после — файл убран, чужие модели целы', async () => {
    const model = loadCatalog().models.find((item) => item.tag === TAG);
    const file = modelFilePath(paths(), model?.repo ?? '', 'Qwen3.5-9B-Q4_K_M.gguf');
    expect(existsSync(file)).toBe(true);
    const before = killed.length;
    // Удаление сервер не останавливает (L5): отказ с причиной, файл и сервер на месте.
    const refused = await api<{ messageCode?: string }>(
      'DELETE',
      `/api/local-models/models/${encodeURIComponent(TAG)}`,
    );
    expect(refused.status).toBe(409);
    expect(refused.body.messageCode).toBe('local-model-loaded');
    expect(killed.length).toBe(before);
    expect(existsSync(file)).toBe(true);
    await api('POST', '/api/local-models/server/stop');
    const { status } = await api('DELETE', `/api/local-models/models/${encodeURIComponent(TAG)}`);
    expect(status).toBe(200);
    expect(killed.length).toBe(before + 1);
    expect(existsSync(file)).toBe(false);
    expect(existsSync(join(paths().ollamaImport, 'qwen3.5-4b.gguf'))).toBe(true);
    const { body } = await api<LocalModelsInfo>('GET', '/api/local-models');
    expect(body.server.running).toBe(false);
    expect(body.installed.map((item) => item.tag)).toEqual([IMPORT_TAG]);
    // Перенесённую из Ollama снимает то же удаление: ссылка уходит, слой Ollama — цел.
    expect(
      (await api('DELETE', `/api/local-models/models/${encodeURIComponent(IMPORT_TAG)}`)).status,
    ).toBe(200);
    expect(existsSync(join(paths().ollamaImport, 'qwen3.5-4b.gguf'))).toBe(false);
    expect(existsSync(blobPathOf(join(root, 'system-models'), 'sha256:w4'))).toBe(true);
    expect(readState(paths()).imported[IMPORT_TAG]).toBeUndefined();
  });

  // С В2 режим набора хранит страница «Набор панели»; маршрут раздела — её отражение.
  it('набор: режим уходит в набор панели и виден в разделе, неверный отклоняется', async () => {
    expect(
      (await api('PUT', '/api/local-models/kit', { provider: 'claude', mode: 'ours' })).status,
    ).toBe(200);
    expect(
      (await api('PUT', '/api/local-models/kit', { provider: 'claude', mode: 'all' })).status,
    ).toBe(400);
    expect(
      (await api('PUT', '/api/local-models/kit', { provider: 'qwen', mode: 'hybrid' })).status,
    ).toBe(400);
    expect(kit.modeOf('claude')).toBe('ours');
    const info = (await api('GET', '/api/local-models')).body as LocalModelsInfo;
    expect(info.kit.claude).toBe('ours');
  });
});
