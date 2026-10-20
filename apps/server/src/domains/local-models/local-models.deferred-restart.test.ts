import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { createLocalModels, loadCatalog } from './service.ts';
import { localPaths, updateState } from './paths.ts';
import { IDLE_SLEEP_SECONDS, readRecord, type ServerShape } from './server.ts';
import { modelFilePath } from './hf.ts';
import type { FetchLike } from './download.ts';

/**
 * Настройки, которым нужен перезапуск сервера, не обрывают идущий прогон (L4b, п.9): пока
 * прогон идёт, выбор сохраняется, карточка пишет «применится после текущего прогона», а
 * сервер перезапускается, когда прогонов не осталось. Сервис настоящий; подменены сеть до
 * llama-server, запуск процесса, «жив ли номер» и «идёт ли прогон».
 */

interface Stubs {
  writeGguf: (path: string, options?: Record<string, unknown>) => Buffer;
}
const REPO = resolve(import.meta.dirname, '..', '..', '..', '..', '..');
const stubs = (await import(
  pathToFileURL(join(REPO, 'tools', 'qa', 'stub-llama.mjs')).href
)) as Stubs;

const TAG = 'qwen3.6:27b-coding';
const PORT = 11_497;
const BINARY = process.platform === 'win32' ? 'llama-server.exe' : 'llama-server';

let root: string;
let up: boolean;
let nextPid: number;
let alive: Set<number>;
let spawned: number;
/** Идёт ли прогон на локальной модели — подставляет тест. */
let running: boolean;
let awake: boolean;
/** Запуск процесса сервера не удаётся (нет памяти, порт занят) — подставляет тест. */
let spawnFails: boolean;

const net: FetchLike = async (input) => {
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

function service() {
  return createLocalModels({
    appRoot: root,
    env: ENV(),
    port: PORT,
    fetchImpl: net,
    run: async (cmd) => {
      if (cmd === 'nvidia-smi') return 'NVIDIA GeForce RTX 4090, 24564, 22868\n';
      throw new Error(`no ${cmd}`);
    },
    spawnServer: ((_binary: string, _args: string[]) => {
      if (spawnFails) throw new Error('не хватило видеопамяти');
      spawned += 1;
      const pid = nextPid++;
      up = true;
      alive.add(pid);
      return { pid, once: () => undefined, on: () => undefined, unref: () => undefined };
    }) as unknown as Parameters<typeof createLocalModels>[0]['spawnServer'],
    kill: (pid) => {
      alive.delete(pid);
      up = false;
    },
    supervise: { pidAlive: (pid) => alive.has(pid) },
    runActive: () => running,
    awakeHeld: () => awake,
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
    idleSeconds: 0,
  };
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'cc-local-deferred-'));
  spawned = 0;
  nextPid = 8_000;
  alive = new Set();
  up = false;
  running = false;
  awake = false;
  spawnFails = false;
  const paths = localPaths(root, ENV());
  // Окно 65536 — выбор человека (как у владельца): умолчание каталога выросло до 131072 (L6),
  // а эти проверки — о перезапуске и присмотре, не о подборе окна.
  updateState(paths, (state) => {
    state.choices[TAG] = { context: 65_536 };
  });
  const runtimeDir = join(paths.runtime, 'llama-b11583');
  mkdirSync(runtimeDir, { recursive: true });
  writeFileSync(join(runtimeDir, BINARY), '');
  stubs.writeGguf(seededShape(paths).file, { nextn: 1 });
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

const record = () => readRecord(localPaths(root, ENV()));

describe('«держать загруженной» и устройство во время прогона', () => {
  it('прогона нет — перезапуск сразу, ожидания нет (прежнее поведение)', async () => {
    const local = service();
    await local.startServer({ tag: TAG });
    const info = await local.setKeepLoaded(true);
    expect(spawned).toBe(2);
    expect(info.restartPending).toBeUndefined();
    expect(record()?.idleSeconds).toBe(0);
  });

  it('прогон идёт — настройка сохранена, сервер не тронут, карточка ждёт', async () => {
    const local = service();
    await local.startServer({ tag: TAG });
    const pid = record()?.pid;
    running = true;
    const info = await local.setKeepLoaded(true);
    expect(info.keepLoaded).toBe(true);
    expect(info.restartPending).toBe(true);
    expect(spawned).toBe(1);
    expect(record()?.pid).toBe(pid);
    expect((await local.describe()).server.restartPending).toBe(true);
  });

  it('прогон идёт — «применить» ничего не делает; кончился — сервер перезапускается с настройкой', async () => {
    const local = service();
    await local.startServer({ tag: TAG });
    const before = record()?.idleSeconds;
    running = true;
    await local.setKeepLoaded(true);
    expect(await local.applyPending()).toBe(false);
    expect(spawned).toBe(1);
    running = false;
    expect(await local.applyPending()).toBe(true);
    expect(spawned).toBe(2);
    expect(record()?.idleSeconds).toBe(0);
    expect(before).toBe(IDLE_SLEEP_SECONDS);
    expect((await local.describe()).server.restartPending).toBeUndefined();
    // Повторно ждать нечего.
    expect(await local.applyPending()).toBe(false);
    expect(spawned).toBe(2);
  });

  it('устройство: так же откладывается, и применяется по окончании', async () => {
    const local = service();
    await local.startServer({ tag: TAG });
    running = true;
    const info = await local.setDevice('cpu');
    expect(info.restartPending).toBe(true);
    expect(spawned).toBe(1);
    expect(record()?.device).toBe('gpu');
    running = false;
    await local.applyPending();
    expect(spawned).toBe(2);
    expect(record()?.device).toBe('cpu');
  });

  it('сервер не запущен — откладывать нечего, настройка просто сохранена', async () => {
    const local = service();
    running = true;
    const info = await local.setKeepLoaded(true);
    expect(info.restartPending).toBeUndefined();
    expect(spawned).toBe(0);
  });
});

describe('окно и квантование во время прогона', () => {
  it('выбор окна сохранён, перезапуска-работы нет, карточка ждёт; по окончании — окно новое', async () => {
    const local = service();
    await local.startServer({ tag: TAG });
    running = true;
    const result = await local.setChoice({ tag: TAG, context: 32_768 });
    expect(result.choice.context).toBe(32_768);
    expect(result.restart).toBeUndefined();
    expect(spawned).toBe(1);
    expect((await local.describe()).server.restartPending).toBe(true);
    running = false;
    await local.applyPending();
    expect(spawned).toBe(2);
    expect(record()?.context).toBe(32_768);
  });

  it('прогона нет — выбор окна запускает перезапуск работой, как раньше', async () => {
    const local = service();
    await local.startServer({ tag: TAG });
    const result = await local.setChoice({ tag: TAG, context: 32_768 });
    expect(result.restart).toBeDefined();
  });
});

describe('ожидание и другие пути запуска сервера', () => {
  it('человек сам запустил сервер с новым выбором — ожидание снято, второго перезапуска нет', async () => {
    const local = service();
    await local.startServer({ tag: TAG });
    running = true;
    await local.setKeepLoaded(true);
    running = false;
    await local.startServer({ tag: TAG });
    expect((await local.describe()).server.restartPending).toBeUndefined();
    const count = spawned;
    expect(await local.applyPending()).toBe(false);
    expect(spawned).toBe(count);
  });

  it('сервер упал, пока ждёт настройка, — присмотр поднимает его уже с ней', async () => {
    const local = service();
    await local.startServer({ tag: TAG });
    running = true;
    await local.setKeepLoaded(true);
    // Падение сервера: порт закрыт, процесса нет, запись осталась.
    const dead = record()?.pid ?? 0;
    up = false;
    alive.delete(dead);
    expect(await local.upstream(TAG)?.revive()).toBe('restarted');
    expect(record()?.idleSeconds).toBe(0);
    expect((await local.describe()).server.restartPending).toBeUndefined();
  });
});

describe('отложенный перезапуск не теряется молча (L4c, F7)', () => {
  it('сбой подъёма — ожидание остаётся, вторая попытка ещё есть, карточка пока ждёт', async () => {
    const local = service();
    await local.startServer({ tag: TAG });
    running = true;
    await local.setKeepLoaded(true);
    running = false;
    spawnFails = true;
    // Прогон кончился, подъём не удался: настройка не потеряна.
    await local.applyPending().catch(() => undefined);
    expect(local.restartPending()).toBe(true);
    expect((await local.describe()).server.restartPending).toBe(true);
    expect((await local.describe()).server.restartError).toBeUndefined();
  });

  it('вторая попытка удалась — настройка применена, ожидания и ошибки нет', async () => {
    const local = service();
    await local.startServer({ tag: TAG });
    running = true;
    await local.setKeepLoaded(true);
    running = false;
    spawnFails = true;
    await local.applyPending().catch(() => undefined);
    spawnFails = false;
    expect(await local.applyPending()).toBe(true);
    expect(record()?.idleSeconds).toBe(0);
    const server = (await local.describe()).server;
    expect(server.restartPending).toBeUndefined();
    expect(server.restartError).toBeUndefined();
  });

  it('обе попытки не удались — ожидание снято, на карточке причина, больше молча не пробуем', async () => {
    const local = service();
    await local.startServer({ tag: TAG });
    running = true;
    await local.setKeepLoaded(true);
    running = false;
    spawnFails = true;
    await local.applyPending().catch(() => undefined);
    await local.applyPending().catch(() => undefined);
    const server = (await local.describe()).server;
    expect(server.restartPending).toBeUndefined();
    expect(server.restartError).toContain('видеопамяти');
    // Человек запустил сервер сам — настройка действует, старая ошибка уходит.
    spawnFails = false;
    await local.startServer({ tag: TAG });
    expect(record()?.idleSeconds).toBe(0);
    expect((await local.describe()).server.restartError).toBeUndefined();
  });

  it('ожидание переживает перезапуск панели: новый экземпляр применяет его, когда прогонов нет', async () => {
    const first = service();
    await first.startServer({ tag: TAG });
    running = true;
    await first.setKeepLoaded(true);
    expect(first.restartPending()).toBe(true);
    // Панель перезапустилась: память пуста, файл состояния остался.
    const second = service();
    expect(second.restartPending()).toBe(true);
    expect((await second.describe()).server.restartPending).toBe(true);
    expect(await second.applyPending()).toBe(false);
    running = false;
    expect(await second.applyPending()).toBe(true);
    expect(record()?.idleSeconds).toBe(0);
    expect(service().restartPending()).toBe(false);
  });
});

describe('запрет сна системе: настройка и состояние', () => {
  it('по умолчанию включён; выключение и включение сохраняются, перезапуска не вызывают', async () => {
    const local = service();
    await local.startServer({ tag: TAG });
    expect((await local.describe()).server.keepAwake).toBe(true);
    expect(local.keepAwakeOn()).toBe(true);
    const off = await local.setKeepAwake(false);
    expect(off.keepAwake).toBe(false);
    expect(local.keepAwakeOn()).toBe(false);
    // Перечитано заново из файла состояния.
    expect(service().keepAwakeOn()).toBe(false);
    expect((await local.setKeepAwake(true)).keepAwake).toBe(true);
    expect(spawned).toBe(1);
  });

  it('карточка называет, что запрет стоит прямо сейчас', async () => {
    const local = service();
    expect((await local.describe()).server.awake).toBeUndefined();
    awake = true;
    expect((await local.describe()).server.awake).toBe(true);
  });
});
