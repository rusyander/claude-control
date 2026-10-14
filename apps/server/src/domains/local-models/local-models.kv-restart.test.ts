import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { createLocalModels, loadCatalog } from './service.ts';
import { localPaths, readState, type LocalPaths } from './paths.ts';
import {
  IDLE_SLEEP_SECONDS,
  readRecord,
  startServer,
  START_TIMEOUT_MS,
  type ServerShape,
} from './server.ts';
import { modelFilePath } from './hf.ts';
import { loadRelease } from './runtime.ts';
import type { FetchLike } from './download.ts';

/**
 * Сервис, подбор и запись о сервере — настоящие; подменены только сеть (llama-server
 * отвечает по /health, остальное — Hugging Face и GitHub) и запуск процесса.
 * Кеш контекста — аргумент запуска, как и окно: сервер, поднятый с другим кешем,
 * обязан перезапуститься, а с тем же — нет.
 */

interface Stubs {
  writeGguf: (path: string, options?: Record<string, unknown>) => Buffer;
  ggufBuffer: (options?: Record<string, unknown>) => Buffer;
  zipBuffer: (files: Record<string, Buffer>) => Buffer;
  fakeNet: (spec: Record<string, unknown>) => {
    fetchImpl: FetchLike;
    requests: { url: string; range?: string }[];
  };
}
const REPO = resolve(import.meta.dirname, '..', '..', '..', '..', '..');
const stubs = (await import(
  pathToFileURL(join(REPO, 'tools', 'qa', 'stub-llama.mjs')).href
)) as Stubs;

const TAG = 'qwen3.6:27b-coding';
const PORT = 11_499;
const BINARY = process.platform === 'win32' ? 'llama-server.exe' : 'llama-server';

let root: string;
let up: boolean;
let spawned: { args: string[]; env: NodeJS.ProcessEnv }[];
let killed: number[];

/** Сеть до llama-server: жив, пока `up`; до остальных хостов — не доходит. */
const fakeServerNet: FetchLike = async (input) => {
  if (!String(input).startsWith(`http://127.0.0.1:${PORT}`)) throw new TypeError('fetch failed');
  if (!up) throw new TypeError('fetch failed');
  if (String(input).endsWith('/health')) return Response.json({ status: 'ok' });
  return new Response('{}', { status: 404 });
};

const ENV = (): NodeJS.ProcessEnv => ({
  AGENTDECK_LOCAL_MODELS_DIR: join(root, 'lm'),
  PATH: '',
  LOCALAPPDATA: join(root, 'appdata'),
  ProgramFiles: join(root, 'programs'),
  HOME: root,
  USERPROFILE: root,
});

function service(fetchImpl: FetchLike = fakeServerNet, extra: { cuda?: boolean } = {}) {
  return createLocalModels({
    appRoot: root,
    env: ENV(),
    port: PORT,
    fetchImpl,
    // Простой 4090 по живому замеру 07.10: свободно 22868 из 24564 МиБ.
    run: async (cmd, args) => {
      if (cmd === 'nvidia-smi')
        return args.length === 0 && extra.cuda
          ? '| NVIDIA-SMI 600.00  Driver Version: 600.00  CUDA Version: 13.4 |'
          : 'NVIDIA GeForce RTX 4090, 24564, 22868\n';
      throw new Error(`no ${cmd}`);
    },
    spawnServer: ((_binary: string, args: string[], options: { env: NodeJS.ProcessEnv }) => {
      spawned.push({ args, env: options.env });
      up = true;
      return { pid: 4242, once: () => undefined, unref: () => undefined };
    }) as unknown as Parameters<typeof createLocalModels>[0]['spawnServer'],
    kill: (pid) => {
      killed.push(pid);
      up = false;
    },
  });
}

/** Что поднимет сервис для 27B на этой карте: окно по умолчанию, q8_0, всё на карте, MTP из заголовка. */
function seededShape(paths: LocalPaths, kvCache: 'q8_0' | 'q4_0'): ServerShape {
  const model = loadCatalog().models.find((item) => item.tag === TAG);
  if (!model) throw new Error('27B not in catalog');
  const quant = model.quants.find((item) => item.id === model.defaultQuant);
  if (!quant) throw new Error('default quant missing');
  return {
    tag: TAG,
    file: modelFilePath(paths, model.repo, quant.file),
    quant: quant.id,
    context: 65_536,
    kvCache,
    device: 'gpu',
    mtp: true,
    offload: 'all',
    // Простой по умолчанию (L4): запуск прежней панели без него — другой запуск.
    idleSeconds: IDLE_SLEEP_SECONDS,
  };
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'cc-local-kv-'));
  spawned = [];
  killed = [];
  const paths = localPaths(root, ENV());
  const runtimeDir = join(paths.runtime, 'llama-b11583');
  mkdirSync(runtimeDir, { recursive: true });
  writeFileSync(join(runtimeDir, BINARY), '');
  // Модель «скачана»: настоящий заголовок GGUF со слоем MTP.
  const shape = seededShape(paths, 'q4_0');
  stubs.writeGguf(shape.file, { nextn: 1 });
  // Сервер идёт с тем же окном, что подберёт панель, но на q4_0: расходится только кеш.
  mkdirSync(paths.run, { recursive: true });
  writeFileSync(
    paths.pidFile,
    JSON.stringify({ ...shape, pid: 999_999_999, port: PORT, binary: '', startedAt: Date.now() }),
  );
  up = true;
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('перезапуск сервера при смене кеша контекста', () => {
  it('сервер на q4_0 перезапускается на q8_0, запись помнит q8_0, второй вызов его не трогает', async () => {
    const local = service();
    const first = await local.startServer({ tag: TAG });
    expect(killed).toEqual([999_999_999]);
    expect(spawned).toHaveLength(1);
    const args = spawned[0]?.args ?? [];
    expect(args[args.indexOf('-ctk') + 1]).toBe('q8_0');
    expect(args[args.indexOf('-c') + 1]).toBe('65536');
    expect(args).toContain('--spec-type');
    expect(first).toMatchObject({ running: true, context: 65_536, kvCache: 'q8_0', model: TAG });
    const paths = localPaths(root, ENV());
    expect(readRecord(paths)?.kvCache).toBe('q8_0');

    // Тот же запуск — сервер подхватывается как есть, без нового процесса.
    await local.startServer({ tag: TAG });
    expect(spawned).toHaveLength(1);
    expect(killed).toHaveLength(1);
  });

  it('кеш, названный человеком, бьёт подбор и запоминается для следующего запуска', async () => {
    const local = service();
    await local.startServer({ tag: TAG, kvCache: 'q4_0' });
    // Сервер уже на q4_0 с тем же окном: перезапуск не нужен.
    expect(spawned).toHaveLength(0);
    expect(readState(localPaths(root, ENV())).choices[TAG]?.kvCache).toBe('q4_0');
    await local.startServer({ tag: TAG });
    expect(spawned).toHaveLength(0);
  });

  it('окно выше предела модели отклоняется с кодом, сервер не трогается', async () => {
    const local = service();
    await expect(local.startServer({ tag: TAG, context: 10_000_000 })).rejects.toMatchObject({
      messageCode: 'local-context-range',
    });
    expect(spawned).toHaveLength(0);
    expect(killed).toHaveLength(0);
  });

  it('модель не скачана — отказ с кодом, а не запуск на несуществующем файле', async () => {
    const local = service();
    await expect(local.startServer({ tag: 'qwen3.5:9b' })).rejects.toMatchObject({
      messageCode: 'local-model-missing',
    });
    expect(spawned).toHaveLength(0);
  });
});

describe('сервер, не ответивший вовремя', () => {
  it('снимается, а не остаётся сиротой на порту без записи', async () => {
    // Живой случай 07.10: поиск видеокарт занял 51 с, панель ждала 30, удалила
    // запись и бросила процесс — следующий запуск упёрся в «порт занят».
    const paths = localPaths(root, ENV());
    rmSync(paths.pidFile, { force: true });
    up = false;
    const stopped: number[] = [];
    const silent = (() => ({
      pid: 5151,
      once: () => undefined,
      unref: () => undefined,
    })) as unknown as Parameters<typeof startServer>[0]['spawnImpl'];
    await expect(
      startServer({
        paths,
        binary: BINARY,
        port: PORT,
        shape: seededShape(paths, 'q8_0'),
        fetchImpl: fakeServerNet,
        spawnImpl: silent,
        timeoutMs: 400,
        kill: (pid) => stopped.push(pid),
      }),
    ).rejects.toMatchObject({ messageCode: 'local-timeout' });
    expect(stopped).toEqual([5151]);
    expect(readRecord(paths)).toBeUndefined();
    expect(START_TIMEOUT_MS).toBeGreaterThanOrEqual(60_000);
  });

  it('вышел сразу — код выхода и журнал в ошибке, снимать нечего', async () => {
    const paths = localPaths(root, ENV());
    rmSync(paths.pidFile, { force: true });
    up = false;
    const stopped: number[] = [];
    const dead = (() => ({
      pid: 5252,
      once: (_event: string, handler: (code: number) => void) => handler(3),
      unref: () => undefined,
    })) as unknown as Parameters<typeof startServer>[0]['spawnImpl'];
    await expect(
      startServer({
        paths,
        binary: BINARY,
        port: PORT,
        shape: seededShape(paths, 'q8_0'),
        fetchImpl: fakeServerNet,
        spawnImpl: dead,
        timeoutMs: 2000,
        kill: (pid) => stopped.push(pid),
      }),
    ).rejects.toMatchObject({ messageCode: 'local-exited' });
    expect(stopped).toEqual([]);
    expect(readRecord(paths)).toBeUndefined();
  });
});

describe('«Скачать и подключить» на машине без сервера моделей', () => {
  it('ставит сервер в той же работе, а не падает с «не установлен»', async () => {
    // Живой путь 08.10: кнопка вызывала pull, а pull сразу требовал готовый
    // сервер — на чистой машине одна кнопка упиралась в первый же шаг.
    rmSync(join(root, 'lm'), { recursive: true, force: true });
    const asked: string[] = [];
    const offline: FetchLike = async (input) => {
      asked.push(String(input));
      throw new TypeError('fetch failed');
    };
    const local = service(offline);
    const job = local.pull({ tag: TAG });
    let state = job.state;
    for (let i = 0; i < 100 && state === 'running'; i++) {
      await new Promise((resolve) => setTimeout(resolve, 20));
      state = (await local.describe()).jobs.find((item) => item.id === job.id)?.state ?? state;
    }
    const done = (await local.describe()).jobs.find((item) => item.id === job.id);
    expect(done?.state).toBe('failed');
    expect(done?.errorCode).not.toBe('local-runtime-missing');
    const release = loadRelease();
    expect(
      asked.some((url) => url.includes(`repos/${release.repo}/releases/tags/${release.tag}`)),
    ).toBe(true);
    local.shutdown();
  });

  it.runIf(process.platform === 'win32')(
    'весь путь: сборка из выпуска, файл модели из репозитория, контур по готовности — без заглушек в самом сервисе',
    async () => {
      // Чистая машина: ни сборки, ни модели, ни записи о сервере, порт свободен.
      up = false;
      rmSync(join(root, 'lm'), { recursive: true, force: true });
      const model = loadCatalog().models.find((item) => item.tag === TAG);
      const quant = model?.quants.find((item) => item.id === model.defaultQuant);
      if (!model || !quant) throw new Error('catalog');
      const weights = stubs.ggufBuffer({ nextn: 1, padBytes: 2048 });
      const release = loadRelease();
      const net = stubs.fakeNet({
        repos: { [model.repo]: { [quant.file]: weights } },
        release: {
          ...release,
          assets: {
            [`llama-${release.tag}-bin-win-cuda-13.4-x64.zip`]: stubs.zipBuffer({
              'llama-server.exe': Buffer.from('binary'),
            }),
            'cudart-llama-bin-win-cuda-13.4-x64.zip': stubs.zipBuffer({
              'cudart64_13.dll': Buffer.from('dll'),
            }),
          },
        },
      });
      const routed: FetchLike = (url, init) =>
        url.startsWith('http://127.0.0.1') ? fakeServerNet(url, init) : net.fetchImpl(url, init);
      const local = service(routed, { cuda: true });
      const calls: string[] = [];
      const inject = async (request: { method: string; url: string }) => {
        calls.push(`${request.method} ${request.url}`);
        return { status: 200, body: { platforms: [], consumers: [], skipped: [] } };
      };
      const job = local.pull({ tag: TAG }, inject);
      let final = job;
      for (let i = 0; i < 300; i += 1) {
        final = (await local.describe()).jobs.find((item) => item.id === job.id) ?? final;
        if (final.state !== 'running') break;
        await new Promise((resolve) => setTimeout(resolve, 30));
      }
      expect({ state: final.state, error: final.error }).toEqual({
        state: 'done',
        error: undefined,
      });
      const paths = localPaths(root, ENV());
      expect(existsSync(join(paths.runtime, `llama-${release.tag}`, 'llama-server.exe'))).toBe(
        true,
      );
      expect(existsSync(modelFilePath(paths, model.repo, quant.file))).toBe(true);
      // Контур заведён через те же маршруты, что и мастер, и сервер поднят на этой модели.
      expect(calls.some((call) => call.startsWith('PUT /api/platforms/'))).toBe(true);
      expect(spawned).toHaveLength(1);
      expect(spawned[0]?.args).toContain(modelFilePath(paths, model.repo, quant.file));
      expect(readState(paths).choices[TAG]?.quant).toBe(quant.id);
      local.shutdown();
    },
  );
});
