import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import {
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import type {
  LocalJob,
  LocalModelsInfo,
  LocalRemoveResult,
} from '@agentdeck/contracts/local-models';
import type { ServerContext } from '../../context.ts';
import { createLocalModels, loadCatalog } from '../../domains/local-models/service.ts';
import { localPaths, readState, updateState } from '../../domains/local-models/paths.ts';
import { modelFilePath } from '../../domains/local-models/hf.ts';
import type { KitService } from '../../domains/kit/service.ts';
import { registerLocalModelsRoutes } from './local-models-routes.ts';

/**
 * Удаление скачанных моделей из интерфейса (L5) по настоящему сокету: маршрут, сервис и
 * файлы на диске во временном каталоге. Подменены только процесс llama-server (запуск,
 * снятие, «жив ли номер»), его HTTP-ответ `/health` и сеть Hugging Face.
 *
 * Сценарий владельца: у модели скачаны три квантования, сервер держит одно — два других
 * удаляются без остановки сервера, а державшее отказывает с понятной причиной.
 */

interface Stubs {
  writeGguf: (path: string, options?: Record<string, unknown>) => Buffer;
}
const REPO = resolve(import.meta.dirname, '..', '..', '..', '..', '..');
const stubs = (await import(
  pathToFileURL(join(REPO, 'tools', 'qa', 'stub-llama.mjs')).href
)) as Stubs;

const TAG = 'qwen3.5:9b';
const PORT = 11_493;
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
let kills: number;
let running: boolean;

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

/** Обрыв запроса к Hugging Face, когда работу отменили: загрузка «идёт», пока её не снимут. */
function hangUntilAborted(init?: RequestInit): Promise<Response> {
  return new Promise((_resolve, reject) => {
    init?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
  });
}

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

const removeUrl = (tag: string, quant?: string): string =>
  `/api/local-models/models/${encodeURIComponent(tag)}${
    quant === undefined ? '' : `?quant=${encodeURIComponent(quant)}`
  }`;

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'cc-local-delete-'));
  up = false;
  alive = new Set();
  nextPid = 9_100;
  kills = 0;
  running = false;
  const runtimeDir = join(paths().runtime, 'llama-b11583');
  mkdirSync(runtimeDir, { recursive: true });
  // Система — linux (числа подбора не зависят от машины теста): имя файла сервера без .exe.
  writeFileSync(join(runtimeDir, 'llama-server'), '');
  for (const quant of ['Q4_K_M', 'UD-Q5_K_XL', 'Q8_0'])
    stubs.writeGguf(pathOf(quant), { nextn: 0, padBytes: 1024 });

  const local = createLocalModels({
    appRoot: root,
    env: ENV(),
    port: PORT,
    os: 'linux',
    fetchImpl: async (input, init) => {
      const url = String(input);
      if (!url.startsWith(`http://127.0.0.1:${PORT}`)) return hangUntilAborted(init);
      if (!up) throw new TypeError('fetch failed');
      if (url.endsWith('/health')) return Response.json({ status: 'ok' });
      return new Response('{}', { status: 404 });
    },
    run: async (cmd) => {
      if (cmd === 'nvidia-smi') return 'NVIDIA GeForce RTX 4090, 24564, 22868\n';
      throw new Error(`no ${cmd}`);
    },
    spawnServer: (() => {
      const pid = nextPid++;
      up = true;
      alive.add(pid);
      return { pid, once: () => undefined, unref: () => undefined };
    }) as unknown as Parameters<typeof createLocalModels>[0]['spawnServer'],
    kill: (pid) => {
      kills += 1;
      alive.delete(pid);
      up = false;
    },
    supervise: { pidAlive: (pid) => alive.has(pid) },
    runActive: () => running,
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
  await app?.close();
  rmSync(root, { recursive: true, force: true });
});

async function startOn(quant: string): Promise<void> {
  const started = await api('POST', '/api/local-models/server/start', { tag: TAG, quant });
  expect(started.status, JSON.stringify(started.body)).toBe(200);
  expect(up).toBe(true);
}

describe('удаление одного квантования', () => {
  it('другое квантование удаляется, сервер с загруженной моделью не трогается; ответ называет освобождённое', async () => {
    await startOn('UD-Q5_K_XL');
    const size = statSync(pathOf('Q4_K_M')).size;
    const { status, body } = await api<LocalRemoveResult>('DELETE', removeUrl(TAG, 'Q4_K_M'));
    expect(status).toBe(200);
    expect(body).toMatchObject({ freedBytes: size, removed: ['Q4_K_M'] });
    expect(existsSync(pathOf('Q4_K_M'))).toBe(false);
    expect(existsSync(pathOf('UD-Q5_K_XL'))).toBe(true);
    expect(existsSync(pathOf('Q8_0'))).toBe(true);
    // Сервер жив: удаление чужого файла его не останавливает.
    expect(up).toBe(true);
    expect(kills).toBe(0);
    const info = await api<LocalModelsInfo>('GET', '/api/local-models');
    const row = info.body.installed.find((item) => item.tag === TAG);
    expect(row?.quants?.sort()).toEqual(['Q8_0', 'UD-Q5_K_XL']);
    expect(row?.files?.map((file) => file.quant).sort()).toEqual(['Q8_0', 'UD-Q5_K_XL']);
  });

  it('квантование, которое держит сервер, — 409 с кодом; файл на месте, сервер жив', async () => {
    await startOn('UD-Q5_K_XL');
    const refused = await api<{ messageCode?: string; error?: string }>(
      'DELETE',
      removeUrl(TAG, 'UD-Q5_K_XL'),
    );
    expect(refused.status).toBe(409);
    expect(refused.body.messageCode).toBe('local-model-loaded');
    expect(refused.body.error).toMatch(/остановите сервер/);
    expect(existsSync(pathOf('UD-Q5_K_XL'))).toBe(true);
    expect(up).toBe(true);
    // Вся модель — тоже отказ: среди её файлов загруженный.
    const whole = await api<{ messageCode?: string }>('DELETE', removeUrl(TAG));
    expect(whole.status).toBe(409);
    expect(whole.body.messageCode).toBe('local-model-loaded');
    expect(existsSync(pathOf('Q4_K_M'))).toBe(true);
  });

  it('после «Остановить» удаляется; выбор переходит на оставшееся квантование, а не на нескачанное', async () => {
    await startOn('UD-Q5_K_XL');
    expect(readState(paths()).choices[TAG]?.quant).toBe('UD-Q5_K_XL');
    await api('POST', '/api/local-models/server/stop');
    const { status } = await api('DELETE', removeUrl(TAG, 'UD-Q5_K_XL'));
    expect(status).toBe(200);
    const fallback = readState(paths()).choices[TAG]?.quant;
    expect(['Q4_K_M', 'Q8_0']).toContain(fallback);
    expect(existsSync(pathOf(fallback ?? ''))).toBe(true);
  });

  it('последнее квантование: выбора квантования нет, модель не значится скачанной, строка снова скачивается', async () => {
    updateState(paths(), (state) => {
      state.choices[TAG] = { quant: 'Q8_0', context: 32_768 };
    });
    for (const quant of ['Q4_K_M', 'UD-Q5_K_XL'])
      expect((await api('DELETE', removeUrl(TAG, quant))).status).toBe(200);
    expect(readState(paths()).choices[TAG]?.quant).toBe('Q8_0');
    expect((await api('DELETE', removeUrl(TAG, 'Q8_0'))).status).toBe(200);
    const choice = readState(paths()).choices[TAG];
    expect(choice?.quant).toBeUndefined();
    // Окно, выбранное человеком, остаётся: удалён файл, а не настройка.
    expect(choice?.context).toBe(32_768);
    const info = await api<LocalModelsInfo>('GET', '/api/local-models');
    expect(info.body.installed.some((item) => item.tag === TAG)).toBe(false);
  });
});

describe('удаление всей модели', () => {
  it('все квантования, недокачанные хвосты и пустой каталог репозитория; сервер чужой модели не тронут', async () => {
    // Недокачанное квантование: в списке скачанного его нет, а хвост на диске есть.
    const part = `${modelFilePath(paths(), MODEL.repo, fileOf('Q6_K'))}.part`;
    writeFileSync(part, Buffer.alloc(512, 1));
    const sizes = ['Q4_K_M', 'UD-Q5_K_XL', 'Q8_0'].reduce(
      (sum, quant) => sum + statSync(pathOf(quant)).size,
      0,
    );
    const { status, body } = await api<LocalRemoveResult>('DELETE', removeUrl(TAG));
    expect(status).toBe(200);
    expect(body.freedBytes).toBe(sizes + 512);
    expect(body.removed.sort()).toEqual(['Q4_K_M', 'Q8_0', 'UD-Q5_K_XL']);
    expect(existsSync(part)).toBe(false);
    expect(existsSync(dirname(pathOf('Q8_0')))).toBe(false);
    expect(existsSync(paths().models)).toBe(true);
    expect(kills).toBe(0);
  });
});

describe('модель, забранная из Ollama: жёсткая ссылка', () => {
  function seedOllama(): { blob: string; link: string; bytes: Buffer } {
    const blob = join(root, 'ollama', 'blobs', 'sha256-abc');
    mkdirSync(dirname(blob), { recursive: true });
    const bytes = stubs.writeGguf(blob, { nextn: 0, padBytes: 2048 });
    const link = join(paths().ollamaImport, 'qwen3.5-9b.gguf');
    mkdirSync(dirname(link), { recursive: true });
    linkSync(blob, link);
    updateState(paths(), (state) => {
      state.imported[TAG] = {
        file: 'ollama-import/qwen3.5-9b.gguf',
        sizeBytes: bytes.length,
        mtp: false,
        importedAt: '2026-10-15T00:00:00.000Z',
      };
    });
    return { blob, link, bytes };
  }

  it('удаляется только наша ссылка: файл Ollama цел и читается, место не освобождается (0 байт)', async () => {
    const { blob, link, bytes } = seedOllama();
    expect(statSync(blob).nlink).toBe(2);
    const { status, body } = await api<LocalRemoveResult>('DELETE', removeUrl(TAG, 'Ollama'));
    expect(status).toBe(200);
    expect(body.freedBytes).toBe(0);
    expect(existsSync(link)).toBe(false);
    expect(readFileSync(blob).equals(bytes)).toBe(true);
    expect(statSync(blob).nlink).toBe(1);
    expect(readState(paths()).imported[TAG]).toBeUndefined();
  });

  it('снимок говорит заранее: у ссылки на файл Ollama удаление освобождает 0 байт', async () => {
    seedOllama();
    const info = await api<LocalModelsInfo>('GET', '/api/local-models');
    const files = info.body.installed.find((item) => item.tag === TAG)?.files ?? [];
    expect(files.find((file) => file.quant === 'Ollama')).toMatchObject({
      source: 'ollama',
      freesBytes: 0,
    });
    expect(files.find((file) => file.quant === 'Q8_0')?.freesBytes).toBe(
      statSync(pathOf('Q8_0')).size,
    );
  });
});

describe('путь за пределами каталога моделей — отказ, чужой файл цел', () => {
  it('запись импорта указывает прямо в хранилище Ollama', async () => {
    const blob = join(root, 'ollama', 'blobs', 'sha256-def');
    mkdirSync(dirname(blob), { recursive: true });
    writeFileSync(blob, 'ollama weights');
    updateState(paths(), (state) => {
      state.imported[TAG] = {
        file: '../../ollama/blobs/sha256-def',
        sizeBytes: 14,
        mtp: false,
        importedAt: '2026-10-15T00:00:00.000Z',
      };
    });
    const refused = await api<{ messageCode?: string }>('DELETE', removeUrl(TAG, 'Ollama'));
    expect(refused.status).toBe(409);
    expect(refused.body.messageCode).toBe('local-model-path');
    expect(readFileSync(blob, 'utf8')).toBe('ollama weights');
  });

  it('своя модель с репозиторием «../..» в записи', async () => {
    const victim = join(root, 'victim', 'Evil-Q4_K_M.gguf');
    mkdirSync(dirname(victim), { recursive: true });
    writeFileSync(victim, 'not ours');
    updateState(paths(), (state) => {
      state.custom['hf:evil/x'] = {
        ...MODEL,
        tag: 'hf:evil/x',
        repo: '../../victim',
        quants: [{ id: 'Q4_K_M', file: 'Evil-Q4_K_M.gguf', sizeBytes: 8 }],
        defaultQuant: 'Q4_K_M',
        custom: true,
      };
    });
    const refused = await api<{ messageCode?: string }>('DELETE', removeUrl('hf:evil/x'));
    expect(refused.status).toBe(409);
    expect(refused.body.messageCode).toBe('local-model-path');
    expect(readFileSync(victim, 'utf8')).toBe('not ours');
  });

  it('тег с «..» не уводит удаление манифеста за каталог', async () => {
    const victim = join(root, 'victim', 'txt');
    mkdirSync(dirname(victim), { recursive: true });
    writeFileSync(victim, 'keep me');
    const refused = await api<{ messageCode?: string }>('DELETE', removeUrl('../../../victim:txt'));
    expect(refused.status).toBe(409);
    expect(refused.body.messageCode).toBe('local-model-path');
    expect(readFileSync(victim, 'utf8')).toBe('keep me');
  });
});

describe('идущая работа — отказ', () => {
  it('прогон идёт, а выбранное квантование ждёт перезапуска сервера: его файл не удаляется', async () => {
    await startOn('UD-Q5_K_XL');
    running = true;
    const chosen = await api('PUT', '/api/local-models/choice', {
      tag: TAG,
      quant: 'Q8_0',
      context: 32_768,
    });
    expect(chosen.status).toBe(200);
    const refused = await api<{ messageCode?: string }>('DELETE', removeUrl(TAG, 'Q8_0'));
    expect(refused.status).toBe(409);
    expect(refused.body.messageCode).toBe('local-model-run-active');
    expect(existsSync(pathOf('Q8_0'))).toBe(true);
    // Остальное удаляется и во время прогона.
    expect((await api('DELETE', removeUrl(TAG, 'Q4_K_M'))).status).toBe(200);
    // Прогон кончился — тот же файл удаляется.
    running = false;
    expect((await api('DELETE', removeUrl(TAG, 'Q8_0'))).status).toBe(200);
  });

  it('идёт загрузка этой модели — 409, файлы на месте', async () => {
    rmSync(pathOf('Q4_K_M'));
    const pulled = await api<LocalJob>('POST', '/api/local-models/pull', {
      tag: TAG,
      quant: 'Q4_K_M',
    });
    expect(pulled.body.state).toBe('running');
    const refused = await api<{ messageCode?: string }>('DELETE', removeUrl(TAG, 'Q8_0'));
    expect(refused.status).toBe(409);
    expect(refused.body.messageCode).toBe('local-model-downloading');
    expect(existsSync(pathOf('Q8_0'))).toBe(true);
    await api('POST', `/api/local-models/jobs/${pulled.body.id}/cancel`);
  });

  it('пустое или слишком длинное имя квантования — 400 до сервиса', async () => {
    expect((await api('DELETE', `${removeUrl(TAG)}?quant=`)).status).toBe(400);
    expect((await api('DELETE', removeUrl(TAG, 'Q'.repeat(81)))).status).toBe(400);
  });
});
