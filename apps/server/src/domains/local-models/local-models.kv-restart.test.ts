import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { TARGET_CONTEXT } from '@agentdeck/contracts/local-models';
import { createLocalModels } from './service.ts';
import { localPaths } from './paths.ts';
import { readRecord, startServer, START_TIMEOUT_MS } from './server.ts';
import type { FetchLike } from './ollama-client.ts';

/**
 * Кеш контекста задаётся всему серверу, как и контекст: сервис обязан
 * перезапустить сервер, поднятый с другим кешем, и не перезапускать его снова,
 * когда кеш уже тот. Настоящие сервис, подбор и запись о сервере; подменены
 * только сеть до Ollama и запуск процесса.
 */

const TAG = 'qwen3.6:27b-coding';
const PORT = 11_499;

let root: string;
let up: boolean;
let spawned: NodeJS.ProcessEnv[];

const fakeOllama: FetchLike = async (input, init) => {
  const url = String(input);
  if (!up) throw new TypeError('fetch failed');
  if (url.endsWith('/api/version')) return Response.json({ version: '0.35.1' });
  // Одна мелкая модель в памяти: её выгрузка и есть момент, когда «процесс» уходит.
  if (url.endsWith('/api/ps'))
    return Response.json({
      models: [{ name: 'warm:1b', size: 1, size_vram: 1, expires_at: '' }],
    });
  if (url.endsWith('/api/generate') && init?.method === 'POST') {
    up = false;
    return Response.json({});
  }
  return new Response('{}', { status: 404 });
};

function service(): ReturnType<typeof createLocalModels> {
  return createLocalModels({
    appRoot: root,
    env: {
      AGENTDECK_LOCAL_MODELS_DIR: join(root, 'lm'),
      PATH: '',
      LOCALAPPDATA: join(root, 'appdata'),
      ProgramFiles: join(root, 'programs'),
      HOME: root,
      USERPROFILE: root,
    },
    port: PORT,
    fetchImpl: fakeOllama,
    // Простой 4090 по живому замеру 07.10: свободно 22868 из 24564 МиБ.
    run: async (cmd) => {
      if (cmd === 'nvidia-smi') return 'NVIDIA GeForce RTX 4090, 24564, 22868\n';
      throw new Error(`no ${cmd}`);
    },
    spawnServer: ((_binary: string, _args: string[], options: { env: NodeJS.ProcessEnv }) => {
      spawned.push(options.env);
      up = true;
      return { pid: 4242, once: () => undefined, unref: () => undefined };
    }) as unknown as Parameters<typeof createLocalModels>[0]['spawnServer'],
  });
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'cc-local-kv-'));
  spawned = [];
  const paths = localPaths(root, { AGENTDECK_LOCAL_MODELS_DIR: join(root, 'lm') });
  const runtimeDir = join(paths.runtime, 'ollama-0.35.1');
  mkdirSync(runtimeDir, { recursive: true });
  writeFileSync(join(runtimeDir, process.platform === 'win32' ? 'ollama.exe' : 'ollama'), '');
  writeFileSync(join(runtimeDir, 'agentdeck-release.json'), JSON.stringify({ version: '0.35.1' }));
  // Сервер уже идёт с 131072 на q8_0 — запись старше выбора кеша, поля нет.
  mkdirSync(paths.run, { recursive: true });
  writeFileSync(
    paths.pidFile,
    JSON.stringify({
      pid: 999_999_999,
      port: PORT,
      binary: '',
      context: TARGET_CONTEXT,
      device: 'gpu',
      startedAt: Date.now(),
    }),
  );
  up = true;
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('перезапуск сервера при смене кеша контекста', () => {
  it('сервер на q8_0 перезапускается на q4_0, запись помнит q4_0, второй вызов его не трогает', async () => {
    const local = service();
    const first = await local.startServer(TAG);
    expect(spawned).toHaveLength(1);
    expect(spawned[0]?.OLLAMA_KV_CACHE_TYPE).toBe('q4_0');
    expect(spawned[0]?.OLLAMA_CONTEXT_LENGTH).toBe(String(TARGET_CONTEXT));
    expect(first).toMatchObject({ running: true, context: TARGET_CONTEXT, kvCache: 'q4_0' });
    const paths = localPaths(root, { AGENTDECK_LOCAL_MODELS_DIR: join(root, 'lm') });
    expect(readRecord(paths)?.kvCache).toBe('q4_0');

    // Тот же контекст и кеш — сервер подхватывается как есть, без нового запуска.
    await local.startServer(TAG);
    expect(spawned).toHaveLength(1);
  });
});

describe('сервер, не ответивший вовремя', () => {
  it('снимается, а не остаётся сиротой на порту без записи', async () => {
    // Живой случай 07.10: поиск видеокарт занял 51 с, панель ждала 30, удалила
    // запись и бросила процесс — следующий запуск упёрся в «порт занят».
    const paths = localPaths(root, { AGENTDECK_LOCAL_MODELS_DIR: join(root, 'lm') });
    rmSync(paths.pidFile, { force: true });
    up = false;
    const killed: number[] = [];
    const silent = (() => ({
      pid: 5151,
      once: () => undefined,
      unref: () => undefined,
    })) as unknown as Parameters<typeof startServer>[0]['spawnImpl'];
    await expect(
      startServer({
        paths,
        binary: 'ollama',
        port: PORT,
        context: 32_768,
        fetchImpl: fakeOllama,
        spawnImpl: silent,
        timeoutMs: 400,
        kill: (pid) => killed.push(pid),
      }),
    ).rejects.toMatchObject({ messageCode: 'local-timeout' });
    expect(killed).toEqual([5151]);
    expect(readRecord(paths)).toBeUndefined();
    expect(START_TIMEOUT_MS).toBeGreaterThanOrEqual(60_000);
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
    const local = createLocalModels({
      appRoot: root,
      env: {
        AGENTDECK_LOCAL_MODELS_DIR: join(root, 'lm'),
        PATH: '',
        LOCALAPPDATA: join(root, 'appdata'),
        ProgramFiles: join(root, 'programs'),
        HOME: root,
        USERPROFILE: root,
      },
      port: PORT,
      fetchImpl: offline,
      run: async (cmd) => {
        if (cmd === 'nvidia-smi') return 'NVIDIA GeForce RTX 4090, 24564, 22868\n';
        throw new Error(`no ${cmd}`);
      },
    });
    const job = local.pull(TAG);
    let state = job.state;
    for (let i = 0; i < 100 && state === 'running'; i++) {
      await new Promise((resolve) => setTimeout(resolve, 20));
      state = (await local.describe()).jobs.find((item) => item.id === job.id)?.state ?? state;
    }
    const done = (await local.describe()).jobs.find((item) => item.id === job.id);
    expect(done?.state).toBe('failed');
    expect(done?.errorCode).not.toBe('local-runtime-missing');
    expect(asked.some((url) => url.includes('github.com/repos/ollama/ollama/releases'))).toBe(true);
    local.shutdown();
  });
});
