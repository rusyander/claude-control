import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { appendFileSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { createLocalModels, loadCatalog } from './service.ts';
import { localPaths, updateState } from './paths.ts';
import { IDLE_SLEEP_SECONDS, readRecord, type ServerShape } from './server.ts';
import { MAX_RESTARTS } from './supervisor.ts';
import { modelFilePath } from './hf.ts';
import type { FetchLike } from './download.ts';
import { fakeCoreHold, refuse } from './__fixtures__/fake-core-hold.ts';

/**
 * Присмотр за сервером на настоящем сервисе (L4b): запись о сервере, подъём по ней и
 * сообщение карточки — настоящие; подменены сеть до llama-server, запуск процесса и
 * «жив ли номер процесса». Присмотр ходит своим таймером (`resume()`, такт 20 мс). Подъём по
 * запросу чата и окно для шлюза ушли вместе со шлюзом панели (этап 10, C3d).
 */

interface Stubs {
  writeGguf: (path: string, options?: Record<string, unknown>) => Buffer;
}
const REPO = resolve(import.meta.dirname, '..', '..', '..', '..', '..');
const stubs = (await import(
  pathToFileURL(join(REPO, 'tools', 'qa', 'stub-llama.mjs')).href
)) as Stubs;

const TAG = 'qwen3.6:27b-coding';
const PORT = 11_498;
const BINARY = process.platform === 'win32' ? 'llama-server.exe' : 'llama-server';

let root: string;
let up: boolean;
let nextPid: number;
let alive: Set<number>;
let spawned: number;
/** Сколько раз удержание освобождено — так видно, что присмотр снял зависший сервер. */
let released: number;
/** Запуск не удаётся: процесс сразу выходит с кодом. */
let crashOnStart: boolean;
/** Через сколько снятый процесс «уходит»; 0 — сразу. */
let killDelayMs = 0;
/** Что падающий запуск пишет в журнал сервера — как llama-server перед выходом. */
let crashLine = '';
/** Часы сервиса: пауза между неудачными подъёмами по запросу. */
let clock = 1_000_000;
/** Что отвечает `nvidia-smi`: имя, всего и свободно, МиБ. */
let smi = 'NVIDIA GeForce RTX 4090, 24564, 22868';
/** Ответ `GET /slots`; нет — 404, как у сервера без каталога слотов. */
let slots: unknown;

const net: FetchLike = async (input) => {
  if (!String(input).startsWith(`http://127.0.0.1:${PORT}`)) throw new TypeError('fetch failed');
  if (!up) throw new TypeError('fetch failed');
  if (String(input).endsWith('/health')) return Response.json({ status: 'ok' });
  if (String(input).endsWith('/slots') && slots !== undefined) return Response.json(slots);
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

function service(extra: Partial<Parameters<typeof createLocalModels>[0]> = {}) {
  return createLocalModels({
    ...extra,
    appRoot: root,
    env: ENV(),
    port: PORT,
    fetchImpl: net,
    run: async (cmd) => {
      if (cmd === 'nvidia-smi') return `${smi}\n`;
      throw new Error(`no ${cmd}`);
    },
    hold: fakeCoreHold({
      hold: () => {
        spawned += 1;
        const pid = nextPid++;
        if (crashOnStart) {
          // Сервер пишет причину в свой журнал (`log-file` пресета) и выходит — ядро отказывает.
          if (crashLine) appendFileSync(localPaths(root, ENV()).serverLog, `${crashLine}\n`);
          throw refuse('local_load_failed', `router failed to load ${TAG} (exit 1)`);
        }
        up = true;
        alive.add(pid);
        return pid;
      },
      release: (pid) => {
        released += 1;
        up = false;
        // Снятый процесс отпускает порт не сразу: окно, в котором человек успевает нажать «Стоп».
        if (killDelayMs > 0) setTimeout(() => alive.delete(pid), killDelayMs).unref();
        else alive.delete(pid);
      },
    }),
    supervise: extra.supervise ?? { pidAlive: (pid) => alive.has(pid) },
    now: () => clock,
  });
}

function seededShape(paths: ReturnType<typeof localPaths>): ServerShape {
  const model = loadCatalog().models.find((item) => item.tag === TAG);
  if (!model) throw new Error('27B not in catalog');
  const quant = model.quants.find((item) => item.id === model.defaultQuant);
  if (!quant) throw new Error('default quant missing');
  return {
    tag: TAG,
    file: modelFilePath(paths, model.repo, quant.file),
    quant: quant.id,
    context: 65_536,
    kvCache: 'q8_0',
    device: 'gpu',
    mtp: true,
    offload: 'all',
    idleSeconds: IDLE_SLEEP_SECONDS,
  };
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'cc-local-supervisor-'));
  spawned = 0;
  released = 0;
  nextPid = 7_000;
  alive = new Set();
  crashOnStart = false;
  killDelayMs = 0;
  crashLine = '';
  clock = 1_000_000;
  smi = 'NVIDIA GeForce RTX 4090, 24564, 22868';
  slots = undefined;
  up = false;
  const paths = localPaths(root, ENV());
  const runtimeDir = join(paths.runtime, 'llama-b11583');
  // Окно 65536 — выбор человека (как у владельца): умолчание каталога выросло до 131072 (L6),
  // а эти проверки — о перезапуске и присмотре, не о подборе окна.
  updateState(paths, (state) => {
    state.choices[TAG] = { context: 65_536 };
  });
  mkdirSync(runtimeDir, { recursive: true });
  writeFileSync(join(runtimeDir, BINARY), '');
  const shape = seededShape(paths);
  stubs.writeGguf(shape.file, { nextn: 1 });
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

async function startedAndKilled(local: ReturnType<typeof service>): Promise<number> {
  await local.startServer({ tag: TAG });
  const record = readRecord(localPaths(root, ENV()));
  if (!record) throw new Error('no record after start');
  // Сервер падает: порт закрыт, процесса нет, запись о нём остаётся.
  up = false;
  alive.delete(record.pid);
  return record.pid;
}

/** Ждать, пока условие станет верным (таймеры присмотра настоящие, сроки — доли секунды). */
async function until(check: () => boolean, ms = 3_000): Promise<void> {
  for (let waited = 0; waited < ms && !check(); waited += 20)
    await new Promise((resolve) => setTimeout(resolve, 20));
}

/** Присмотр на быстром такте: настоящий таймер сервиса, запускается `resume()`, как при старте панели. */
async function supervised(): Promise<ReturnType<typeof service>> {
  const local = service({ supervise: { pidAlive: (pid) => alive.has(pid), intervalMs: 20 } });
  await local.resume();
  return local;
}

describe('сервер моделей упал — присмотр поднимает его по записи', () => {
  it('присмотр видит упавший сервер и поднимает его теми же параметрами, окно не меняется', async () => {
    const local = await supervised();
    const before = await startedAndKilled(local);
    await until(() => spawned === 2 && up);
    expect(spawned).toBe(2);
    const record = readRecord(localPaths(root, ENV()));
    expect(record?.pid).not.toBe(before);
    expect(record?.context).toBe(65_536);
    expect(record?.tag).toBe(TAG);
    // Сообщение видно карточке сервера.
    expect((await local.describe()).server.notice).toMatchObject({ kind: 'restarted' });
    local.shutdown();
  });

  it('подъём не удаётся: после трёх попыток — потолок, причина в сообщении карточки', async () => {
    const local = await supervised();
    await startedAndKilled(local);
    crashOnStart = true;
    await until(() => spawned === 1 + MAX_RESTARTS);
    // Часы сервиса стоят: окно потолка не прошло, четвёртой попытки нет.
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(spawned).toBe(1 + MAX_RESTARTS);
    const shown = (await local.describe()).server.notice;
    expect(shown).toMatchObject({ kind: 'gave-up', restarts: MAX_RESTARTS });
    expect(shown?.reason).toBeTruthy();
    local.shutdown();
  });

  it('человек запускает сервер сам — потолок сброшен, сообщение снято', async () => {
    const local = await supervised();
    await startedAndKilled(local);
    crashOnStart = true;
    await until(() => spawned === 1 + MAX_RESTARTS);
    crashOnStart = false;
    await local.startServer({ tag: TAG });
    expect((await local.describe()).server.notice).toBeUndefined();
    local.shutdown();
  });
});

describe('«Стоп» человека посреди подъёма зависшего сервера (L4c, F4)', () => {
  it('процесс жив, /health молчит; присмотр снимает его и ждёт порт; Стоп в этом окне — сервер не поднимается', async () => {
    const local = await supervised();
    await local.startServer({ tag: TAG });
    // Зависший: порт молчит, процесс жив. Снятие отпускает его не сразу — окно ожидания порта.
    killDelayMs = 700;
    up = false;
    const spawnedBefore = spawned;
    await until(() => released === 1);
    expect(released).toBe(1);
    await local.stopServer();
    // Окно ожидания порта прошло: подъём, отменённый «Стопом», процесс не запускает.
    await new Promise((resolve) => setTimeout(resolve, 1_200));
    expect(spawned).toBe(spawnedBefore);
    expect(readRecord(localPaths(root, ENV()))).toBeUndefined();
    expect((await local.describe()).server.notice).toBeUndefined();
    local.shutdown();
  });
});
