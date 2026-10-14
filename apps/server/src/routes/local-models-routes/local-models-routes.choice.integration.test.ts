import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import {
  benchStale,
  catalogModelSchema,
  fitChoice,
  modelNeedGb,
  resolveChoice,
  type CatalogModel,
  type LocalChoiceResult,
  type LocalJob,
  type LocalModelsInfo,
  type ModelBench,
} from '@agentdeck/contracts/local-models';
import type { ServerContext } from '../../context.ts';
import { createLocalModels, loadCatalog } from '../../domains/local-models/service.ts';
import { localPaths, readState, updateState } from '../../domains/local-models/paths.ts';
import { loadRelease } from '../../domains/local-models/runtime.ts';
import { KitService } from '../../domains/kit/service.ts';
import { registerLocalModelsRoutes } from './local-models-routes.ts';

/**
 * Выбор квантования и окна и «Любая модель» поверх настоящего сокета: настоящие
 * маршруты и сервис, вместо llama-server — заглушка с тем же HTTP-лицом, вместо
 * Hugging Face — `fakeNet`. Карта — RTX 4090 (24 ГБ, свободно ~19,5), система —
 * linux: на Windows чужую видеопамять считают вытесняемой, и цифры зависели бы
 * от машины, на которой идёт тест.
 */

interface StubLlama {
  port: number;
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

const REPO_ROOT = resolve(import.meta.dirname, '..', '..', '..', '..', '..');
const TAG = 'qwen3.5:9b';
const CUSTOM_REPO = 'acme/Tiny-Coder-GGUF';
const CUSTOM_TAG = `hf:${CUSTOM_REPO}`;

let stubs: Stubs;
let root: string;
let app: FastifyInstance;
let base: string;
let port: number;
let server: StubLlama | undefined;
let net: ReturnType<Stubs['fakeNet']>;
let model: CatalogModel;
const spawned: { args: string[] }[] = [];
const platforms = { active: '', saved: undefined as Record<string, unknown> | undefined };
let toolsAnswer: { ok: boolean } | undefined = { ok: true };

const lm = (): string => join(root, 'lm');
/** МиБ, которые держит идущий сервер по нашей же оценке: запись о запуске → `modelNeedGb`. */
function heldMiB(): number {
  try {
    const record = JSON.parse(readFileSync(paths().pidFile, 'utf8')) as {
      context: number;
      kvCache: 'q8_0' | 'q4_0';
      quant: string;
    };
    return Math.round(modelNeedGb(model, record.context, record.kvCache, record.quant) * 1024);
  } catch {
    return 0;
  }
}
const paths = (): ReturnType<typeof localPaths> =>
  localPaths(root, { AGENTDECK_LOCAL_MODELS_DIR: lm() });
const gpu = {
  vendor: 'nvidia' as const,
  name: 'NVIDIA GeForce RTX 4090',
  vramGb: 24,
  freeGb: 19.5,
  bandwidthGbs: 1008,
  bandwidthFrom: 'table' as const,
};

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
    if (job && job.state !== 'running') {
      return job;
    }
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

const argOf = (args: string[], flag: string): string => args[args.indexOf(flag) + 1] ?? '';
const lastSpawn = (): string[] => spawned.at(-1)?.args ?? [];

beforeAll(async () => {
  stubs = (await import(
    pathToFileURL(join(REPO_ROOT, 'tools', 'qa', 'stub-llama.mjs')).href
  )) as Stubs;
  root = mkdtempSync(join(tmpdir(), 'cc-local-choice-'));
  port = await freeTcpPort();
  const runtimeDir = join(paths().runtime, `llama-${loadRelease().tag}`);
  mkdirSync(runtimeDir, { recursive: true });
  writeFileSync(join(runtimeDir, 'llama-server'), '');

  const found = loadCatalog().models.find((item) => item.tag === TAG);
  if (!found) throw new Error(`${TAG} not in catalog`);
  // Ту же схему, что и сервер, разбирает и страница: модель с размером по умолчанию и кешем на токен.
  model = catalogModelSchema.parse(found);
  const q4 = model.quants.find((item) => item.id === 'Q4_K_M');
  const q8 = model.quants.find((item) => item.id === 'Q8_0');
  const bf16 = model.quants.find((item) => item.id === 'BF16');
  if (!q4 || !q8 || !bf16) throw new Error('quants missing');

  const small = stubs.ggufBuffer({ nextn: 0, padBytes: 4096 });
  const tiny = (arch: Record<string, unknown>): Buffer =>
    stubs.ggufBuffer({ padBytes: 4096, ...arch });
  net = stubs.fakeNet({
    repos: {
      [model.repo]: {
        [q4.file]: small,
        [q8.file]: Buffer.concat([small, Buffer.alloc(16, 5)]),
        [bf16.file]: Buffer.concat([small, Buffer.alloc(32, 6)]),
      },
      // «Любая модель»: два квантования, устройство в заголовке, карточка с числом параметров.
      [CUSTOM_REPO]: {
        'Tiny-Coder-Q4_K_M.gguf': tiny({
          layers: 32,
          kvHeads: 8,
          headDim: 128,
          contextLength: 100_000,
        }),
        'Tiny-Coder-Q8_0.gguf': Buffer.concat([
          tiny({ layers: 32, kvHeads: 8, headDim: 128, contextLength: 100_000 }),
          Buffer.alloc(64, 9),
        ]),
        'mmproj-F16.gguf': Buffer.alloc(100, 1),
      },
      'acme/docs-only': { 'README.md': Buffer.from('# no weights') },
      // Заголовок без числа голов и длины головы: память под окно посчитать нечем.
      'acme/no-layout-GGUF': {
        'Odd-Q4_K_M.gguf': tiny({ omitKvHeads: true, omitKeyLength: true }),
      },
      // Смесь экспертов без `key_length`: длина головы — из ширины слоя и числа голов.
      'acme/Moe-GGUF': {
        'Moe-Q4_K_M.gguf': tiny({
          layers: 48,
          omitKeyLength: true,
          embeddingLength: 2048,
          headCount: 16,
          kvHeads: 4,
          experts: 128,
          expertsUsed: 8,
          fullAttentionInterval: 4,
          nextn: 1,
        }),
      },
    },
    cards: {
      [CUSTOM_REPO]: { gguf: { total: 7_000_000_000 } },
      'acme/Moe-GGUF': { gguf: { total: 30_000_000_000 } },
    },
  });

  const local = createLocalModels({
    appRoot: root,
    env: {
      AGENTDECK_LOCAL_MODELS_DIR: lm(),
      OLLAMA_MODELS: join(root, 'no-ollama'),
      PATH: '',
      HOME: root,
      USERPROFILE: root,
    },
    os: 'linux',
    port,
    fetchImpl: (url, init) =>
      String(url).startsWith('http://127.0.0.1')
        ? fetch(url, init)
        : net.fetchImpl(String(url), init),
    run: async (cmd) => {
      if (cmd !== 'nvidia-smi') throw new Error(`no ${cmd}`);
      // Загруженная модель занимает видеопамять, как на настоящей карте: иначе подбор
      // «вернёт» её дважды — в свободной и в зачтённой за свой же сервер.
      const held = server ? heldMiB() : 0;
      return `NVIDIA GeForce RTX 4090, 24564, ${20_000 - held}
`;
    },
    spawnServer: ((_binary: string, args: string[]) => {
      spawned.push({ args });
      void stubs
        .startStubLlama({ port: Number(argOf(args, '--port')), tokensPerSec: 42 })
        .then((started) => {
          server = started;
        });
      return { pid: 888_000 + spawned.length, once: () => undefined, unref: () => undefined };
    }) as unknown as Parameters<typeof createLocalModels>[0]['spawnServer'],
    kill: () => {
      void server?.close();
      server = undefined;
    },
    testLoad: async () => ({ ok: true }),
  });

  app = Fastify();
  app.get('/api/platforms', () => ({
    activePlatformId: platforms.active,
    platforms: platforms.saved ? [{ platform: platforms.saved }] : [],
  }));
  app.put<{ Body: { settings: Record<string, unknown> } }>('/api/platforms/:id', (request) => {
    platforms.saved = request.body.settings;
    return { ok: true };
  });
  app.get('/api/platforms/:id/apply', () => ({ consumers: [] }));
  app.post('/api/platforms/:id/apply', () => ({ applied: [], skipped: [] }));
  app.post('/api/platforms/:id/activate', () => {
    platforms.active = 'local-ollama';
    return { activePlatformId: 'local-ollama', smoke: { ok: true, tools: toolsAnswer } };
  });
  const kit = new KitService({
    appDataDir: join(root, 'app-data'),
    claudeDir: () => join(root, 'claude'),
    providers: () => [{ id: 'claude', name: 'Claude Code' }],
  });
  const ctx = { store: { getSettings: () => ({ remoteAccess: { enabled: false } }) } };
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

const put = (body: Record<string, unknown>) =>
  api<LocalChoiceResult & { messageCode?: string; params?: Record<string, number> }>(
    'PUT',
    '/api/local-models/choice',
    { tag: TAG, ...body },
  );

describe('выбор квантования и окна: сохраняется на сервере и ведёт каждый запуск', () => {
  it('выбор запоминается в state.json и виден в снимке; сервера нет — перезапускать нечего', async () => {
    const { status, body } = await put({ quant: 'Q8_0', context: 32_768 });
    expect(status).toBe(200);
    expect(body.choice).toEqual({ quant: 'Q8_0', context: 32_768 });
    expect(body.restart).toBeUndefined();
    expect(readState(paths()).choices[TAG]).toEqual({ quant: 'Q8_0', context: 32_768 });
    const info = await api<LocalModelsInfo>('GET', '/api/local-models');
    expect(info.body.choices[TAG]).toEqual({ quant: 'Q8_0', context: 32_768 });
    expect(spawned).toHaveLength(0);
  });

  it('выбор, который не влезает, — отказ с цифрами «нужно из доступно»; в файл ничего не попало', async () => {
    const before = readFileSync(paths().state, 'utf8');
    // BF16 при 256K: 22,3 ГБ нужно, 19,5 ГБ свободно.
    const { status, body } = await put({ quant: 'BF16', context: 262_144 });
    expect(status).toBe(409);
    expect(body.messageCode).toBe('local-choice-no-fit');
    const params = body.params ?? {};
    expect(params.need).toBeCloseTo(22.3, 1);
    // Доступно — свободная сейчас видеопамять (20000 МиБ), а не вся карта.
    expect(params.available).toBeCloseTo(19.5, 1);
    expect(readFileSync(paths().state, 'utf8')).toBe(before);
  });

  it('неизвестное квантование и окно выше предела модели — отказы с кодом', async () => {
    const quant = await put({ quant: 'Q0_NOPE' });
    expect(quant.status).toBe(409);
    expect(quant.body.messageCode).toBe('local-quant-unknown');
    const context = await put({ context: model.contextMax * 2 });
    expect(context.status).toBe(409);
    expect(context.body.messageCode).toBe('local-context-range');
    const unknown = await api<{ messageCode?: string }>('PUT', '/api/local-models/choice', {
      tag: 'no:such',
      quant: 'Q4_K_M',
    });
    expect(unknown.body.messageCode).toBe('local-model-unknown');
  });

  it('частичная выгрузка — только если человек её разрешил: тот же выбор без галочки отклонён, с ней принят', async () => {
    const target = { quant: 'BF16', context: 131_072 };
    // BF16 при 128K частично уходит в оперативную память (карта держит 19,5 из 20,2 нужных).
    expect(fitChoice(model, gpu, 63.8, target, false)).toMatchObject({
      level: 'partial',
      allowed: false,
    });
    const refused = await put(target);
    expect(refused.status).toBe(409);
    expect(refused.body.messageCode).toBe('local-choice-no-fit');
    expect(readState(paths()).choices[TAG]?.allowPartial).toBeUndefined();
    const allowed = await put({ ...target, allowPartial: true });
    expect(allowed.status).toBe(200);
    expect(allowed.body.choice).toEqual({ ...target, allowPartial: true });
    // Вернуть в исходное для следующих проверок.
    await put({ quant: 'Q8_0', context: 32_768, allowPartial: false });
    expect(readState(paths()).choices[TAG]).toEqual({
      quant: 'Q8_0',
      context: 32_768,
      allowPartial: false,
    });
  });

  it('скачивание берёт квантование из выбора; запуск и замер — тоже, на выбранном окне', async () => {
    // Выбрано Q8_0 при 32768 — его и качает кнопка без тела квантования.
    const started = await api<LocalJob>('POST', '/api/local-models/pull', { tag: TAG });
    expect((await finished(started.body.id)).state).toBe('done');
    expect(net.requests.some((item) => item.url.endsWith('Qwen3.5-9B-Q8_0.gguf'))).toBe(true);
    const bench = await api<ModelBench>('POST', '/api/local-models/bench', { tag: TAG });
    expect(bench.status).toBe(200);
    expect(spawned).toHaveLength(1);
    expect(argOf(lastSpawn(), '-c')).toBe('32768');
    expect(lastSpawn().some((arg) => arg.endsWith('Qwen3.5-9B-Q8_0.gguf'))).toBe(true);
    // Замер помнит, на чём снят.
    expect(bench.body).toMatchObject({
      context: 32_768,
      quant: 'Q8_0',
      kvCache: 'q8_0',
      offload: 'all',
    });
    expect(readState(paths()).bench[TAG]).toMatchObject({ context: 32_768, quant: 'Q8_0' });
  });

  it('смена окна на загруженной модели — перезапуск работой «restart» с новым -c; тот же выбор — без перезапуска', async () => {
    const same = await put({ quant: 'Q8_0', context: 32_768 });
    expect(same.body.restart).toBeUndefined();
    expect(spawned).toHaveLength(1);

    const changed = await put({ context: 65_536 });
    expect(changed.status).toBe(200);
    expect(changed.body.restart).toMatchObject({ kind: 'server', target: TAG, state: 'running' });
    const job = await finished(changed.body.restart?.id ?? '');
    expect(job.state).toBe('done');
    expect(spawned).toHaveLength(2);
    expect(argOf(lastSpawn(), '-c')).toBe('65536');
    const info = await api<LocalModelsInfo>('GET', '/api/local-models');
    expect(info.body.server).toMatchObject({ running: true, context: 65_536, quant: 'Q8_0' });
  });

  it('замер при другом выборе устарел: окно и квантование замера сверяются с выбором (benchStale)', async () => {
    const info = await api<LocalModelsInfo>('GET', '/api/local-models');
    const stored = info.body.installed.find((item) => item.tag === TAG)?.bench;
    expect(stored).toMatchObject({ context: 32_768, quant: 'Q8_0' });
    const hw = info.body.hardware;
    const shown = resolveChoice(model, hw.gpus[0], hw.ramGb, info.body.choices[TAG], 'Q8_0');
    expect(shown).toMatchObject({ quant: 'Q8_0', context: 65_536 });
    expect(benchStale(stored ?? {}, shown)).toBe('other');
    expect(benchStale({ context: 65_536, quant: 'Q8_0' }, shown)).toBeUndefined();
  });

  it('квантование, которого нет на диске, сервер не трогает: выбор запомнен, перезапуска нет — даже если окно другое', async () => {
    // Окно тоже меняется: без условия «файл выбранного квантования на диске» сервер
    // перезапустился бы с новым окном на ЧУЖОМ файле, а человек просил другой.
    const { body } = await put({ quant: 'Q4_K_M', context: 32_768 });
    expect(body.restart).toBeUndefined();
    expect(spawned).toHaveLength(2);
    expect(readState(paths()).choices[TAG]).toMatchObject({ quant: 'Q4_K_M', context: 32_768 });
    await put({ quant: 'Q4_K_M', context: 65_536 });
  });

  it('прежний явный тип кеша не переживает новый выбор: тип подбирается под новую пару', async () => {
    // Запись с явным kvCache оставил прежний запуск с телом, где он назван.
    updateState(paths(), (state) => {
      state.choices[TAG] = { ...state.choices[TAG], kvCache: 'q4_0' };
    });
    expect(readState(paths()).choices[TAG]?.kvCache).toBe('q4_0');
    await put({ quant: 'Q4_K_M', context: 32_768 });
    expect(readState(paths()).choices[TAG]?.kvCache).toBeUndefined();
    await put({ quant: 'Q4_K_M', context: 65_536 });
  });

  it('скачанное другое квантование выбрано на загруженной модели — перезапуск на нём', async () => {
    const pulled = await api<LocalJob>('POST', '/api/local-models/pull', { tag: TAG });
    expect((await finished(pulled.body.id)).state).toBe('done');
    // Выбор Q4_K_M уже сохранён; сервер на Q8_0. Возврат выбора на Q8_0 и обратно даёт перезапуск.
    await put({ quant: 'Q8_0', context: 65_536 });
    const { body } = await put({ quant: 'Q4_K_M', context: 65_536 });
    expect(body.restart).toMatchObject({ kind: 'server' });
    expect((await finished(body.restart?.id ?? '')).state).toBe('done');
    expect(lastSpawn().some((arg) => arg.endsWith('Qwen3.5-9B-Q4_K_M.gguf'))).toBe(true);
    expect(argOf(lastSpawn(), '-c')).toBe('65536');
  });

  it('выбор переживает перезапуск панели: файл состояния читается заново тем же ответом', () => {
    const reread = readState(paths()).choices[TAG];
    expect(reread).toMatchObject({ quant: 'Q4_K_M', context: 65_536 });
    const picked = resolveChoice(model, gpu, 63.8, reread, 'Q4_K_M');
    expect(picked).toMatchObject({ quant: 'Q4_K_M', context: 65_536 });
  });

  it('тип кеша — под выбранное окно: BF16 при 64K влезает только с q4_0, и сервер поднимается с ним', async () => {
    const pick = { quant: 'BF16', context: 65_536 };
    expect(fitChoice(model, gpu, 63.8, pick)).toMatchObject({ level: 'gpu', kvCache: 'q4_0' });
    const pulled = await api<LocalJob>('POST', '/api/local-models/pull', { tag: TAG, ...pick });
    expect((await finished(pulled.body.id)).state).toBe('done');
    const { body } = await put(pick);
    expect((await finished(body.restart?.id ?? '')).state).toBe('done');
    expect(lastSpawn().some((arg) => arg.endsWith('BF16.gguf'))).toBe(true);
    expect(argOf(lastSpawn(), '-ctk')).toBe('q4_0');
    expect(argOf(lastSpawn(), '-ctv')).toBe('q4_0');
    // Обратно на Q8_0 — кеш снова q8_0: тип не залипает от прежнего выбора.
    const back = await put({ quant: 'Q8_0', context: 65_536 });
    expect((await finished(back.body.restart?.id ?? '')).state).toBe('done');
    expect(argOf(lastSpawn(), '-ctk')).toBe('q8_0');
  });
});

describe('«Любая модель»: репозиторий → квантования и устройство → скачивание → убрать', () => {
  it('ссылка на репозиторий даёт запись: квантования без проектора, слои и головы из заголовка, предел окна из файла', async () => {
    const before = net.requests.length;
    const { status, body } = await api<CatalogModelWire>('POST', '/api/local-models/custom', {
      input: `https://huggingface.co/${CUSTOM_REPO}/tree/main`,
    });
    expect(status).toBe(200);
    expect(body).toMatchObject({
      tag: CUSTOM_TAG,
      repo: CUSTOM_REPO,
      custom: true,
      toolsProbe: 'unknown',
      agentic: true,
      defaultQuant: 'Q4_K_M',
      contextMax: 100_000,
      paramsB: 7,
      arch: { layers: 32, kvLayers: 32, kvHeads: 8, headDim: 128 },
    });
    expect(body.quants.map((item) => item.id)).toEqual(['Q4_K_M', 'Q8_0']);
    // Начало файла берётся диапазоном, а не файлом целиком.
    const head = net.requests.slice(before).find((item) => item.url.includes('/resolve/'));
    expect(head?.range).toMatch(/^bytes=0-\d+$/);
    // Модель появилась в снимке той же строкой каталога — с теми же селекторами.
    const info = await api<LocalModelsInfo>('GET', '/api/local-models');
    expect(info.body.catalog.models.at(-1)).toMatchObject({ tag: CUSTOM_TAG, custom: true });
    // Повторное добавление не плодит вторую запись.
    const again = await api<CatalogModelWire>('POST', '/api/local-models/custom', {
      input: CUSTOM_REPO,
    });
    expect(again.body.tag).toBe(CUSTOM_TAG);
    expect(Object.keys(readState(paths()).custom)).toEqual([CUSTOM_TAG]);
  });

  it('смесь экспертов: длина головы из ширины слоя и числа голов, слои с кешем — каждый 4-й, MTP виден', async () => {
    const { body } = await api<CatalogModelWire>('POST', '/api/local-models/custom', {
      input: 'hf.co/acme/Moe-GGUF:Q4_K_M',
    });
    expect(body).toMatchObject({
      tag: 'hf:acme/Moe-GGUF',
      mtp: true,
      arch: { layers: 48, kvLayers: 12, kvHeads: 4, headDim: 128 },
    });
    // Не плотная: активных параметров меньше всех.
    expect(body.activeParamsB).toBeLessThan(body.paramsB);
    await api('DELETE', `/api/local-models/models/${encodeURIComponent('hf:acme/Moe-GGUF')}`);
  });

  it('плохой ввод, репозиторий без GGUF и без устройства в заголовке — отказы с кодом, записи нет', async () => {
    const bad = await api<{ messageCode?: string }>('POST', '/api/local-models/custom', {
      input: 'просто слова',
    });
    expect(bad.body.messageCode).toBe('local-custom-input');
    const docs = await api<{ messageCode?: string }>('POST', '/api/local-models/custom', {
      input: 'acme/docs-only',
    });
    expect(docs.body.messageCode).toBe('local-custom-no-gguf');
    const odd = await api<{ messageCode?: string }>('POST', '/api/local-models/custom', {
      input: 'acme/no-layout-GGUF',
    });
    expect(odd.body.messageCode).toBe('local-custom-no-arch');
    const missing = await api<{ messageCode?: string }>('POST', '/api/local-models/custom', {
      input: 'acme/does-not-exist',
    });
    expect(missing.status).toBe(409);
    expect(Object.keys(readState(paths()).custom)).toEqual([CUSTOM_TAG]);
  });

  it('те же селекторы: выбор для модели вне каталога, скачивание выбранного квантования', async () => {
    const choice = await api<LocalChoiceResult>('PUT', '/api/local-models/choice', {
      tag: CUSTOM_TAG,
      quant: 'Q8_0',
      context: 32_768,
    });
    expect(choice.status).toBe(200);
    const pulled = await api<LocalJob>('POST', '/api/local-models/pull', { tag: CUSTOM_TAG });
    expect((await finished(pulled.body.id)).state).toBe('done');
    const info = await api<LocalModelsInfo>('GET', '/api/local-models');
    expect(info.body.installed.find((item) => item.tag === CUSTOM_TAG)).toMatchObject({
      quant: 'Q8_0',
      known: true,
    });
  });

  it('агентность: не проверена, пока проба не прошла; подключение с пробой «ok» снимает пометку, «failed» делает не-агентом', async () => {
    const read = async (): Promise<CatalogModelWire | undefined> =>
      (await api<LocalModelsInfo>('GET', '/api/local-models')).body.catalog.models.find(
        (item) => item.tag === CUSTOM_TAG,
      ) as CatalogModelWire | undefined;
    expect((await read())?.toolsProbe).toBe('unknown');

    toolsAnswer = { ok: true };
    const ok = await api('POST', '/api/local-models/connect', { tag: CUSTOM_TAG });
    expect(ok.status).toBe(200);
    expect(await read()).toMatchObject({ toolsProbe: 'ok', agentic: true });

    toolsAnswer = { ok: false };
    await api('POST', '/api/local-models/connect', { tag: CUSTOM_TAG });
    expect(await read()).toMatchObject({ toolsProbe: 'failed', agentic: false });
    toolsAnswer = undefined;
  });

  it('убрать: файлы, запись и выбор исчезают, сервер, державший её, снят', async () => {
    const removed = await api(
      'DELETE',
      `/api/local-models/models/${encodeURIComponent(CUSTOM_TAG)}`,
    );
    expect(removed.status).toBe(200);
    const state = readState(paths());
    expect(state.custom[CUSTOM_TAG]).toBeUndefined();
    expect(state.choices[CUSTOM_TAG]).toBeUndefined();
    expect(state.tools[CUSTOM_TAG]).toBeUndefined();
    const info = await api<LocalModelsInfo>('GET', '/api/local-models');
    expect(info.body.catalog.models.some((item) => item.tag === CUSTOM_TAG)).toBe(false);
    expect(info.body.installed.some((item) => item.tag === CUSTOM_TAG)).toBe(false);
  });
});

type CatalogModelWire = CatalogModel & { messageCode?: string };
