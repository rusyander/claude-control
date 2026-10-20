import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import type { LocalActivity, LocalServerInfo } from '@agentdeck/contracts/local-models';
import type { ServerContext } from '../../context.ts';
import { createLocalModels, loadCatalog } from '../../domains/local-models/service.ts';
import { localPaths } from '../../domains/local-models/paths.ts';
import { readRecord } from '../../domains/local-models/server.ts';
import { modelFilePath } from '../../domains/local-models/hf.ts';
import type { KitService } from '../../domains/kit/service.ts';
import { registerLocalModelsRoutes } from './local-models-routes.ts';

/**
 * Находки ревью L6 по настоящему сокету: маршрут, сервис, запись о сервере и файлы на диске во
 * временном каталоге. Подменены только процесс llama-server (запуск, снятие, «жив ли номер»)
 * и его `/health`.
 * - m5: `GET /api/local-models/activity` и `POST /api/local-models/server/restart`;
 * - m1: «Перезапустить» и «Запустить» одновременно — один живой сервер, запись о нём верна;
 * - m4: запись стёрта неудачным подъёмом, а присмотр помнит сервер — его файл не удаляется.
 */

interface Stubs {
  writeGguf: (path: string, options?: Record<string, unknown>) => Buffer;
}
const REPO = resolve(import.meta.dirname, '..', '..', '..', '..', '..');
const stubs = (await import(
  pathToFileURL(join(REPO, 'tools', 'qa', 'stub-llama.mjs')).href
)) as Stubs;

const TAG = 'qwen3.5:9b';
const PORT = 11_492;
const MODEL = loadCatalog().models.find((item) => item.tag === TAG);
if (!MODEL) throw new Error(`${TAG} not in catalog`);
const fileOf = (quant: string): string => {
  const found = MODEL.quants.find((item) => item.id === quant);
  if (!found) throw new Error(`no ${quant}`);
  return found.file;
};

let root: string;
let app: FastifyInstance;
let base: string;
let up: boolean;
let alive: Set<number>;
let nextPid: number;
/** Запуск не удаётся: процесс сразу выходит с кодом 1. */
let crash: boolean;
/** Через сколько поднятый процесс начинает отвечать на `/health`; 0 — сразу. */
let startDelayMs: number;
let local: ReturnType<typeof createLocalModels>;

const ENV = (): NodeJS.ProcessEnv => ({
  AGENTDECK_LOCAL_MODELS_DIR: join(root, 'lm'),
  OLLAMA_MODELS: join(root, 'ollama'),
  PATH: '',
  LOCALAPPDATA: join(root, 'appdata'),
  ProgramFiles: join(root, 'programs'),
  HOME: root,
  USERPROFILE: root,
});
const paths = () => localPaths(root, ENV());
const pathOf = (quant: string): string => modelFilePath(paths(), MODEL.repo, fileOf(quant));

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

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'cc-local-l6-review-'));
  up = false;
  alive = new Set();
  nextPid = 9_300;
  crash = false;
  startDelayMs = 0;
  const runtimeDir = join(paths().runtime, 'llama-b11583');
  mkdirSync(runtimeDir, { recursive: true });
  writeFileSync(join(runtimeDir, 'llama-server'), '');
  for (const quant of ['Q4_K_M', 'UD-Q5_K_XL'])
    stubs.writeGguf(pathOf(quant), { nextn: 0, padBytes: 1024 });

  local = createLocalModels({
    appRoot: root,
    env: ENV(),
    port: PORT,
    os: 'linux',
    fetchImpl: async (input) => {
      const url = String(input);
      if (!url.startsWith(`http://127.0.0.1:${PORT}`) || !up) throw new TypeError('fetch failed');
      if (url.endsWith('/health')) return Response.json({ status: 'ok' });
      return new Response('{}', { status: 404 });
    },
    run: async (cmd) => {
      if (cmd === 'nvidia-smi') return 'NVIDIA GeForce RTX 4090, 24564, 22868\n';
      throw new Error(`no ${cmd}`);
    },
    spawnServer: (() => {
      const pid = nextPid++;
      if (crash) {
        return {
          pid,
          once: (event: string, callback: (code: number) => void) => {
            if (event === 'exit') callback(1);
          },
          on: () => undefined,
          unref: () => undefined,
        };
      }
      alive.add(pid);
      if (startDelayMs > 0)
        setTimeout(() => {
          up = alive.size > 0;
        }, startDelayMs);
      else up = true;
      return { pid, once: () => undefined, on: () => undefined, unref: () => undefined };
    }) as unknown as Parameters<typeof createLocalModels>[0]['spawnServer'],
    kill: (pid) => {
      alive.delete(pid);
      up = alive.size > 0;
    },
    supervise: { pidAlive: (pid) => alive.has(pid) },
    testLoad: async () => ({ ok: true }),
  });

  app = Fastify();
  app.get('/api/platforms', () => ({ activePlatformId: '', platforms: [] }));
  const kit = { modeOf: () => 'global' } as unknown as KitService;
  const ctx = { store: { getSettings: () => ({ remoteAccess: { enabled: false } }) } };
  registerLocalModelsRoutes(app, ctx as unknown as ServerContext, local, kit);
  await app.listen({ port: 0, host: '127.0.0.1' });
  const address = app.server.address();
  base = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`;
});

afterEach(async () => {
  local.shutdown();
  await app?.close();
  rmSync(root, { recursive: true, force: true });
});

describe('состояние локального прогона и перезапуск из чата (ревью m5)', () => {
  it('GET /activity: простой — этап idle, сервер и окно; замер слоя, не влезающий в окно, — с действием', async () => {
    const started = await api('POST', '/api/local-models/server/start', {
      tag: TAG,
      quant: 'Q4_K_M',
      context: 32_768,
    });
    expect(started.status, JSON.stringify(started.body)).toBe(200);
    const idle = await api<LocalActivity>('GET', '/api/local-models/activity');
    expect(idle.status).toBe(200);
    expect(idle.body).toMatchObject({
      phase: 'idle',
      inFlight: 0,
      model: TAG,
      quant: 'Q4_K_M',
      context: 32_768,
    });
    expect(idle.body.layer).toBeUndefined();
    local.upstream(TAG)?.layer(40_000);
    const measured = await api<LocalActivity>('GET', '/api/local-models/activity');
    expect(measured.body.layer).toMatchObject({
      tokens: 40_000,
      context: 32_768,
      limit: 28_672,
      fits: false,
      fix: { context: 65_536 },
    });
  });

  it('POST /server/restart: тот же сервер заново, теми же параметрами; сервера нет — отказ с кодом', async () => {
    const none = await api<{ messageCode?: string }>('POST', '/api/local-models/server/restart');
    expect(none.status).toBeGreaterThanOrEqual(400);
    expect(none.body.messageCode).toBe('local-model-missing');
    await api('POST', '/api/local-models/server/start', { tag: TAG, quant: 'Q4_K_M' });
    const before = readRecord(paths());
    const restarted = await api<LocalServerInfo>('POST', '/api/local-models/server/restart');
    expect(restarted.status, JSON.stringify(restarted.body)).toBe(200);
    expect(restarted.body).toMatchObject({ running: true, model: TAG, quant: 'Q4_K_M' });
    const after = readRecord(paths());
    expect(after?.pid).not.toBe(before?.pid);
    expect(after).toMatchObject({ tag: TAG, quant: 'Q4_K_M', context: before?.context });
    expect([...alive]).toEqual([after?.pid]);
  });
});

describe('запуски сервера идут по одному (ревью m1)', () => {
  it('«Перезапустить» и «Запустить» с другим квантованием одновременно — один живой сервер, запись о нём', async () => {
    await api('POST', '/api/local-models/server/start', { tag: TAG, quant: 'Q4_K_M' });
    // Модель грузится заметное время: два запуска без очереди успели бы лечь друг на друга.
    startDelayMs = 400;
    const [restart, start] = await Promise.all([
      api('POST', '/api/local-models/server/restart'),
      api('POST', '/api/local-models/server/start', { tag: TAG, quant: 'UD-Q5_K_XL' }),
    ]);
    expect(restart.status, JSON.stringify(restart.body)).toBe(200);
    expect(start.status, JSON.stringify(start.body)).toBe(200);
    const record = readRecord(paths());
    expect(record?.quant).toBe('UD-Q5_K_XL');
    // Ни сироты на порту, ни записи о мёртвом процессе.
    expect([...alive]).toEqual([record?.pid]);
  });
});

describe('удаление при стёртой записи (ревью m4)', () => {
  it('подъём после падения не удался — запись стёрта, присмотр помнит сервер: его файл не удаляется', async () => {
    await api('POST', '/api/local-models/server/start', { tag: TAG, quant: 'UD-Q5_K_XL' });
    // Сервер падает, подъём по нему тоже падает: `startServer` стирает запись, цель присмотра остаётся.
    for (const pid of alive) alive.delete(pid);
    up = false;
    crash = true;
    expect(await local.upstream(TAG)?.revive()).toBe('failed');
    expect(readRecord(paths())).toBeUndefined();
    const refused = await api<{ messageCode?: string }>(
      'DELETE',
      `/api/local-models/models/${encodeURIComponent(TAG)}?quant=UD-Q5_K_XL`,
    );
    expect(refused.status).toBe(409);
    expect(refused.body.messageCode).toBe('local-model-loaded');
    expect(existsSync(pathOf('UD-Q5_K_XL'))).toBe(true);
    // Другое квантование удаляется как прежде.
    const other = await api(
      'DELETE',
      `/api/local-models/models/${encodeURIComponent(TAG)}?quant=Q4_K_M`,
    );
    expect(other.status).toBe(200);
    expect(existsSync(pathOf('Q4_K_M'))).toBe(false);
  });
});
