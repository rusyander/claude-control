import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { fitModel, type LocalJob, type LocalModelsInfo } from '@agentdeck/contracts/local-models';
import type { ServerContext } from '../context.ts';
import { createLocalModels, loadCatalog } from '../domains/local-models/service.ts';
import { localPaths, readState } from '../domains/local-models/paths.ts';
import { manifestPathOf, blobPathOf } from '../domains/local-models/store.ts';
import { LOCAL_PLATFORM_ID } from '../domains/local-models/connect.ts';
import { KitService } from '../domains/kit/service.ts';
import { registerLocalModelsRoutes } from './local-models-routes.ts';

/**
 * Весь путь раздела «Локальные модели» поверх настоящего сокета: настоящие
 * маршруты и сервис, вместо Ollama — заглушка `tools/qa/stub-ollama.mjs`,
 * которая пишет манифесты и слои так же, как настоящий сервер. Ни гигабайтов, ни
 * GitHub, ни видеокарты: железо подставлено строкой nvidia-smi, сборка сервера —
 * каталогом с паспортом выпуска, запись о сервере — его портом, поэтому сервис
 * ничего не запускает и не останавливает.
 */

interface StubOllama {
  port: number;
  calls: { method: string; path: string; body: Record<string, unknown> }[];
  close: () => Promise<void>;
}
interface StubModule {
  startStubOllama: (options: {
    modelsDir: string;
    sizes?: Record<string, number>;
  }) => Promise<StubOllama>;
}

const REPO = resolve(import.meta.dirname, '..', '..', '..', '..');
const TAG = 'qwen3.5:9b';
const SIZE = 6_600_000_000;

let root: string;
let kit: KitService;
let stub: StubOllama;
let app: FastifyInstance;
let base: string;
const platformCalls: { method: string; url: string; body: unknown }[] = [];
const platforms = { activePlatformId: '', saved: undefined as Record<string, unknown> | undefined };

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

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'cc-local-routes-'));
  const lm = join(root, 'lm');
  const paths = localPaths(root, { AGENTDECK_LOCAL_MODELS_DIR: lm });
  const { startStubOllama } = (await import(
    pathToFileURL(join(REPO, 'tools', 'qa', 'stub-ollama.mjs')).href
  )) as StubModule;
  stub = await startStubOllama({ modelsDir: paths.models, sizes: { [TAG]: SIZE } });

  // Своя сборка сервера «уже стоит»: каталог с файлом и паспортом выпуска.
  const runtimeDir = join(paths.runtime, 'ollama-0.35.1');
  mkdirSync(runtimeDir, { recursive: true });
  writeFileSync(join(runtimeDir, process.platform === 'win32' ? 'ollama.exe' : 'ollama'), '');
  writeFileSync(join(runtimeDir, 'agentdeck-release.json'), JSON.stringify({ version: '0.35.1' }));

  // Системная папка моделей с одной моделью — для переноса.
  const system = join(root, 'system-models');
  const manifest = manifestPathOf(system, 'qwen3.5:4b');
  mkdirSync(join(manifest, '..'), { recursive: true });
  mkdirSync(join(system, 'blobs'), { recursive: true });
  writeFileSync(blobPathOf(system, 'sha256:c4'), 'cfg');
  writeFileSync(blobPathOf(system, 'sha256:w4'), 'weights');
  writeFileSync(
    manifest,
    JSON.stringify({
      config: { digest: 'sha256:c4', size: 3 },
      layers: [{ digest: 'sha256:w4', size: 7 }],
    }),
  );

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
    port: stub.port,
    run: async (cmd) => {
      if (cmd === 'nvidia-smi') return 'NVIDIA GeForce RTX 4090, 24564, 20000\n';
      throw new Error(`no ${cmd}`);
    },
    spawnServer: () => {
      throw new Error('the service must reuse the running stub, not spawn a server');
    },
  });

  // Запись о сервере с тем контекстом, который сервис выберет для TAG на этой
  // карте: тогда ensureServer подхватывает заглушку как есть.
  const hw = await local.refreshHardware();
  const model = loadCatalog().models.find((item) => item.tag === TAG);
  if (!model) throw new Error(`${TAG} not in catalog`);
  const context = fitModel(model, hw.gpus[0], hw.ramGb).context;
  mkdirSync(paths.run, { recursive: true });
  writeFileSync(
    paths.pidFile,
    JSON.stringify({
      pid: 999_999_999,
      port: stub.port,
      binary: '',
      context,
      startedAt: Date.now(),
    }),
  );

  app = Fastify();
  // Маршруты контура — подделка, которая записывает, что ей прислали.
  app.get('/api/platforms', () => ({
    activePlatformId: platforms.activePlatformId,
    platforms: platforms.saved ? [{ platform: platforms.saved }] : [],
  }));
  app.put<{ Body: { settings: Record<string, unknown> } }>('/api/platforms/:id', (request) => {
    platformCalls.push({ method: 'PUT', url: request.url, body: request.body });
    platforms.saved = request.body.settings;
    return { ok: true };
  });
  app.get('/api/platforms/:id/apply', () => ({
    consumers: [{ id: 'foreign:qwen' }, { id: 'foreign:codex', reason: 'нет' }],
  }));
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
  await stub?.close();
  rmSync(root, { recursive: true, force: true });
});

describe('раздел «Локальные модели» по настоящему сокету', () => {
  it('снимок: карта, своя сборка сервера, работающий сервер, модель для переноса', async () => {
    const { status, body } = await api<LocalModelsInfo>('GET', '/api/local-models');
    expect(status).toBe(200);
    expect(body.hardware.gpus[0]).toMatchObject({ name: 'NVIDIA GeForce RTX 4090', vramGb: 24 });
    expect(body.runtime).toMatchObject({ source: 'panel', version: '0.35.1', outdated: false });
    expect(body.server).toMatchObject({ running: true, port: stub.port });
    expect(body.installed).toEqual([]);
    expect(body.importable).toEqual([{ tag: 'qwen3.5:4b', sizeBytes: 10 }]);
    expect(body.connect).toEqual({ configured: false, active: false, model: '' });
  });

  it('незнакомый тег — 404 с кодом, а не загрузка чего попало', async () => {
    const { status, body } = await api<{ messageCode?: string; error: string }>(
      'POST',
      '/api/local-models/pull',
      { tag: 'evil:latest' },
    );
    expect(status).toBe(404);
    expect(body.messageCode).toBe('local-model-unknown');
  });

  it('«Скачать и подключить»: прогресс по байтам, модель на диске, контур заведён и включён', async () => {
    const started = await api<LocalJob>('POST', '/api/local-models/pull', {
      tag: TAG,
      connect: true,
    });
    expect(started.status).toBe(200);
    expect(started.body).toMatchObject({ kind: 'model', target: TAG, state: 'running' });
    const job = await finished(started.body.id);
    expect(job.state).toBe('done');
    expect(job.totalBytes).toBe(SIZE);
    expect(job.doneBytes).toBe(SIZE);
    expect(existsSync(manifestPathOf(join(root, 'lm', 'models'), TAG))).toBe(true);
    expect(stub.calls.filter((call) => call.path === '/api/pull')).toHaveLength(1);

    // Два PUT: первый с прогонами панели, второй ещё и с Qwen Code (контур его
    // принял), затем включение. Чужой CLI, которому контур отказал, не добавлен.
    const puts = platformCalls.filter((call) => call.method === 'PUT');
    expect(puts).toHaveLength(2);
    const settings = (puts[1]?.body as { settings: Record<string, unknown>; token: string })
      .settings;
    expect(settings).toMatchObject({
      id: LOCAL_PLATFORM_ID,
      driver: 'ollama',
      baseUrl: `http://127.0.0.1:${stub.port}/v1`,
      defaultModel: TAG,
      mode: 'required',
    });
    expect(settings.consumers).toContain('foreign:qwen');
    expect(settings.consumers).not.toContain('foreign:codex');
    expect(platformCalls.at(-1)).toMatchObject({
      method: 'POST',
      url: `/api/platforms/${LOCAL_PLATFORM_ID}/activate`,
    });

    const { body } = await api<LocalModelsInfo>('GET', '/api/local-models');
    expect(body.connect).toEqual({ configured: true, active: true, model: TAG });
    expect(body.installed.map((model) => model.tag)).toEqual([TAG]);
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
    const state = readState(localPaths(root, { AGENTDECK_LOCAL_MODELS_DIR: join(root, 'lm') }));
    expect(state.bench[TAG]?.tokensPerSec).toBe(42);
  });

  it('перенос из системного Ollama — без второй копии на диске', async () => {
    const started = await api<LocalJob>('POST', '/api/local-models/import', { tag: 'qwen3.5:4b' });
    const job = await finished(started.body.id);
    expect(job.state).toBe('done');
    const copied = blobPathOf(join(root, 'lm', 'models'), 'sha256:w4');
    expect(statSync(copied).nlink).toBeGreaterThanOrEqual(2);
  });

  it('удаление идёт через работающий сервер', async () => {
    const { status } = await api('DELETE', `/api/local-models/models/${encodeURIComponent(TAG)}`);
    expect(status).toBe(200);
    expect(stub.calls.at(-1)).toMatchObject({ path: '/api/delete', body: { model: TAG } });
    expect(existsSync(manifestPathOf(join(root, 'lm', 'models'), TAG))).toBe(false);
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
