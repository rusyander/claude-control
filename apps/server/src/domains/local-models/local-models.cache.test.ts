import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { createLocalModels, loadCatalog } from './service.ts';
import { localPaths, readState } from './paths.ts';
import {
  CACHE_REUSE_MIN_CHUNK,
  IDLE_SLEEP_SECONDS,
  PROMPT_CACHE_MAX_MIB,
  PROMPT_CACHE_MIN_MIB,
  promptCacheMib,
  sameShape,
  serverArgs,
  type ServerShape,
} from './server.ts';
import { parseGgufFacts } from './gguf.ts';
import { modelFilePath } from './hf.ts';

/**
 * Кеш промпта и выгрузка по простою (L4, 14.10): настоящие сервис, подбор, запись о
 * сервере и HTTP-разговор с заглушкой llama-server (`stub-llama.mjs`: `/props` с
 * `is_sleeping`, `POST /slots/0?action=erase`, сон не будится `/health` и `/props`, как у
 * настоящего b11583). Подменён только запуск процесса.
 */

interface StubServer {
  port: number;
  calls: { method: string; path: string; query?: string }[];
  sleep: () => void;
  isSleeping: () => boolean;
  close: () => Promise<void>;
}
interface Stubs {
  writeGguf: (path: string, options?: Record<string, unknown>) => Buffer;
  ggufBuffer: (options?: Record<string, unknown>) => Buffer;
  startStubLlama: (options?: { port?: number; slotDir?: string }) => Promise<StubServer>;
}
const REPO = resolve(import.meta.dirname, '..', '..', '..', '..', '..');
const stubs = (await import(
  pathToFileURL(join(REPO, 'tools', 'qa', 'stub-llama.mjs')).href
)) as Stubs;

const TAG = 'qwen3.6:27b-coding';
const PORT = 11_498;
const BINARY = process.platform === 'win32' ? 'llama-server.exe' : 'llama-server';
const GIB = 1024 ** 3;

let root: string;
let spawned: { args: string[] }[];
let stub: StubServer | undefined;
let killed: number;
let starting: Promise<void>[];

const ENV = (): NodeJS.ProcessEnv => ({
  AGENTDECK_LOCAL_MODELS_DIR: join(root, 'lm'),
  PATH: '',
  LOCALAPPDATA: join(root, 'appdata'),
  ProgramFiles: join(root, 'programs'),
  HOME: root,
  USERPROFILE: root,
});

function service(freeGiB = 40, now?: () => number) {
  return createLocalModels({
    appRoot: root,
    env: ENV(),
    port: PORT,
    freeBytes: () => freeGiB * GIB,
    ...(now ? { now } : {}),
    run: async (cmd) => {
      if (cmd === 'nvidia-smi') return 'NVIDIA GeForce RTX 4090, 24564, 22868\n';
      throw new Error(`no ${cmd}`);
    },
    spawnServer: ((_binary: string, args: string[]) => {
      spawned.push({ args });
      starting.push(
        stubs
          .startStubLlama({ port: PORT, slotDir: flag(args, '--slot-save-path') })
          .then((started) => {
            stub = started;
          }),
      );
      return { pid: 4242, once: () => undefined, on: () => undefined, unref: () => undefined };
    }) as unknown as Parameters<typeof createLocalModels>[0]['spawnServer'],
    kill: () => {
      killed += 1;
      const old = stub;
      stub = undefined;
      // Порт закрывается настоящим закрытием заглушки — `stopServer` ждёт именно этого.
      starting.push(old ? old.close() : Promise.resolve());
    },
  });
}

function modelPath(): string {
  const model = loadCatalog().models.find((item) => item.tag === TAG);
  const quant = model?.quants.find((item) => item.id === model.defaultQuant);
  if (!model || !quant) throw new Error('27B not in catalog');
  return modelFilePath(localPaths(root, ENV()), model.repo, quant.file);
}

/** Модель «скачана»: настоящий заголовок GGUF; `arch` решает, гибрид ли это. */
function seedModel(options: Record<string, unknown>): void {
  stubs.writeGguf(modelPath(), options);
}

const flag = (args: string[], name: string): string | undefined => args[args.indexOf(name) + 1];

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'cc-local-cache-'));
  spawned = [];
  starting = [];
  killed = 0;
  stub = undefined;
  const paths = localPaths(root, ENV());
  const runtimeDir = join(paths.runtime, 'llama-b11583');
  mkdirSync(runtimeDir, { recursive: true });
  writeFileSync(join(runtimeDir, BINARY), '');
});

afterEach(async () => {
  await Promise.all(starting);
  await stub?.close();
  rmSync(root, { recursive: true, force: true });
});

const SHAPE: ServerShape = {
  tag: TAG,
  file: '/m/model.gguf',
  quant: 'Q4_K_M',
  context: 65_536,
  kvCache: 'q8_0',
  device: 'gpu',
  mtp: true,
  offload: 'all',
};

describe('--cache-ram от свободной памяти', () => {
  it('четверть свободной, но не больше 8 ГиБ и не меньше гигабайта', () => {
    expect(promptCacheMib(45 * GIB)).toBe(PROMPT_CACHE_MAX_MIB);
    expect(promptCacheMib(24 * GIB)).toBe(6144);
    expect(promptCacheMib(6 * GIB)).toBe(1536);
    expect(promptCacheMib(2 * GIB)).toBe(PROMPT_CACHE_MIN_MIB);
    expect(promptCacheMib(0)).toBe(PROMPT_CACHE_MIN_MIB);
    // Шаг — 256 МиБ: «6,3 ГиБ» не превращается в странное число в журнале сервера.
    expect(promptCacheMib(25.9 * GIB) % 256).toBe(0);
  });

  it('значение доезжает до аргументов запущенного сервера: много памяти — предел, мало — своя четверть', async () => {
    seedModel({ nextn: 1 });
    await service(64).startServer({ tag: TAG });
    expect(flag(spawned[0]?.args ?? [], '--cache-ram')).toBe(String(PROMPT_CACHE_MAX_MIB));
  });

  it('мало свободной памяти — кеш меньше предела', async () => {
    seedModel({ nextn: 1 });
    await service(10).startServer({ tag: TAG });
    expect(flag(spawned[0]?.args ?? [], '--cache-ram')).toBe('2560');
  });
});

describe('--cache-reuse только там, где сервер умеет сдвиг кеша', () => {
  it('плотная модель: флаг есть (замер 7B: пересчёт 6364 → 10 токенов)', () => {
    const args = serverArgs({ ...SHAPE, recurrent: false }, 1);
    expect(flag(args, '--cache-reuse')).toBe(String(CACHE_REUSE_MIN_CHUNK));
    expect(serverArgs(SHAPE, 1)).toContain('--cache-reuse');
  });

  it('гибрид с рекуррентным состоянием: флага нет (на 27B сервер пишет «cache_reuse is not supported»)', () => {
    expect(serverArgs({ ...SHAPE, recurrent: true }, 1)).not.toContain('--cache-reuse');
  });

  it('заголовок GGUF: гибрид по full_attention_interval, по ключам ssm.*, по имени архитектуры; плотная — нет', () => {
    const facts = (options: Record<string, unknown>) => parseGgufFacts(stubs.ggufBuffer(options));
    expect(facts({ arch: 'qwen35' })?.recurrent).toBe(true);
    expect(facts({ arch: 'newhybrid', fullAttentionInterval: 4 })?.recurrent).toBe(true);
    expect(facts({ arch: 'newhybrid', ssm: true })?.recurrent).toBe(true);
    expect(facts({ arch: 'qwen2' })?.recurrent).toBe(false);
    expect(facts({ arch: 'qwen3', fullAttentionInterval: 0 })?.recurrent).toBe(false);
  });

  it('сервис читает это из файла модели: гибридный файл — без флага, плотный — с ним', async () => {
    seedModel({ arch: 'qwen35', nextn: 1 });
    await service().startServer({ tag: TAG });
    expect(spawned[0]?.args).not.toContain('--cache-reuse');
    seedModel({ arch: 'qwen3' });
    // Другой файл — другой запуск: сервер перезапускается уже с флагом.
    rmSync(localPaths(root, ENV()).pidFile, { force: true });
    await Promise.all(starting);
    await stub?.close();
    stub = undefined;
    await service().startServer({ tag: TAG });
    expect(flag(spawned[1]?.args ?? [], '--cache-reuse')).toBe('256');
  });
});

describe('выгрузка по простою', () => {
  it('по умолчанию сервер идёт с --sleep-idle-seconds 600 и каталогом слотов (для сброса кеша)', async () => {
    seedModel({ nextn: 1 });
    await service().startServer({ tag: TAG });
    const args = spawned[0]?.args ?? [];
    expect(flag(args, '--sleep-idle-seconds')).toBe(String(IDLE_SLEEP_SECONDS));
    expect(flag(args, '--slot-save-path')).toBe(localPaths(root, ENV()).slotsDir);
    expect(existsSync(localPaths(root, ENV()).slotsDir)).toBe(true);
  });

  it('«держать загруженной» — без флага простоя; настройка переживает перезапуск панели', async () => {
    seedModel({ nextn: 1 });
    const local = service();
    await local.startServer({ tag: TAG });
    expect(spawned).toHaveLength(1);
    const info = await local.setKeepLoaded(true);
    // Идущий сервер перезапущен: флаг простоя — аргумент запуска.
    expect(killed).toBe(1);
    expect(spawned).toHaveLength(2);
    expect(spawned[1]?.args).not.toContain('--sleep-idle-seconds');
    expect(info).toMatchObject({ running: true, keepLoaded: true });
    expect(readState(localPaths(root, ENV())).keepLoaded).toBe(true);
    // Та же настройка ещё раз — сервер не трогается.
    await local.setKeepLoaded(true);
    expect(spawned).toHaveLength(2);
    // Выключили — снова с флагом.
    await local.setKeepLoaded(false);
    expect(flag(spawned[2]?.args ?? [], '--sleep-idle-seconds')).toBe(String(IDLE_SLEEP_SECONDS));
  });

  it('срок выгрузки на выбор: 15 мин — перезапуск с 900 с, тот же срок — сервер не трогается', async () => {
    seedModel({ nextn: 1 });
    const local = service();
    await local.startServer({ tag: TAG });
    const info = await local.setKeepLoaded(false, 15);
    expect(spawned).toHaveLength(2);
    expect(flag(spawned[1]?.args ?? [], '--sleep-idle-seconds')).toBe('900');
    expect(info).toMatchObject({ idleSeconds: 900, idleMinutes: 15, keepLoaded: false });
    expect(readState(localPaths(root, ENV())).idleMinutes).toBe(15);
    await local.setKeepLoaded(false, 15);
    expect(spawned).toHaveLength(2);
    // «Держать» поверх выбранного срока, затем снова выгрузка — срок не забыт.
    await local.setKeepLoaded(true);
    await local.setKeepLoaded(false);
    expect(flag(spawned[3]?.args ?? [], '--sleep-idle-seconds')).toBe('900');
  });

  it('срок из файла состояния вне выбора — умолчание', () => {
    const paths = localPaths(root, ENV());
    mkdirSync(dirname(paths.state), { recursive: true });
    writeFileSync(paths.state, JSON.stringify({ idleMinutes: 7 }));
    expect(readState(paths).idleMinutes).toBe(IDLE_SLEEP_SECONDS / 60);
  });

  it('сервер не запущен: настройка запоминается, ничего не стартует', async () => {
    seedModel({ nextn: 1 });
    const local = service();
    const info = await local.setKeepLoaded(true);
    expect(spawned).toHaveLength(0);
    expect(info).toMatchObject({
      running: false,
      keepLoaded: true,
      idleSeconds: IDLE_SLEEP_SECONDS,
    });
  });

  it('запуск, различающийся только простоем, — другой запуск', () => {
    expect(sameShape(SHAPE, { ...SHAPE, idleSeconds: 600 })).toBe(false);
    // Запись прежней панели (поля нет) = «держать загруженной».
    expect(sameShape(SHAPE, { ...SHAPE, idleSeconds: 0 })).toBe(true);
    expect(sameShape({ ...SHAPE, idleSeconds: 600 }, { ...SHAPE, idleSeconds: 600 })).toBe(true);
  });

  it('спящий сервер на экране: жив, но «загружено» пусто — память свободна', async () => {
    seedModel({ nextn: 1 });
    const local = service();
    await local.startServer({ tag: TAG });
    expect((await local.describe()).server.loaded).toHaveLength(1);
    stub?.sleep();
    const server = (await local.describe()).server;
    expect(server).toMatchObject({ running: true, sleeping: true, loaded: [] });
    // Показ не будит сервер: ни одного обращения, кроме /health и /props.
    expect(stub?.isSleeping()).toBe(true);
  });
});

describe('сброс кеша слота при смене разговора', () => {
  const erases = (): number =>
    (stub?.calls ?? []).filter(
      (call) =>
        call.method === 'POST' && call.path === '/slots/0' && call.query === '?action=erase',
    ).length;

  async function ready(now?: () => number) {
    seedModel({ nextn: 1 });
    const local = service(40, now);
    await local.startServer({ tag: TAG });
    const upstream = local.upstream(TAG);
    if (!upstream?.prepare) throw new Error('no prepare');
    return { local, prepare: upstream.prepare };
  }

  it('первый разговор и каждая смена сбрасывают кеш; тот же разговор — нет', async () => {
    const { prepare } = await ready();
    await prepare('chat-A');
    expect(erases()).toBe(1);
    await prepare('chat-A');
    await prepare('chat-A');
    expect(erases()).toBe(1);
    await prepare('chat-B');
    expect(erases()).toBe(2);
    // Возврат к первому — тоже смена: чужой префикс (B) не наследуется.
    await prepare('chat-A');
    expect(erases()).toBe(3);
  });

  it('длинный кеш уходящего чата ложится на диск, возврат к нему — из файла, без сброса', async () => {
    const { local, prepare } = await ready();
    const upstream = local.upstream(TAG);
    const action = (name: string): number =>
      (stub?.calls ?? []).filter((call) => call.query === `?action=${name}`).length;
    await prepare('chat-A');
    // Ход чата A: запрос в 30 тыс. токенов — столько окажется в кеше слота.
    upstream?.watch(30_000).done();
    await prepare('chat-B');
    expect(action('save')).toBe(1);
    expect(erases()).toBe(2);
    const slotsDir = localPaths(root, ENV()).slotsDir;
    expect(existsSync(join(slotsDir, 'chat-A.bin'))).toBe(true);
    expect(existsSync(join(slotsDir, 'chat-A.json'))).toBe(true);
    // Чат B короткий — не пишется; A поднимается из файла, слот не стирается.
    await prepare('chat-A');
    expect(action('save')).toBe(1);
    expect(action('restore')).toBe(1);
    expect(erases()).toBe(2);
  });

  it('перед сном по простою кеш пишется на диск — один раз и не раньше срока', async () => {
    let now = 1_000_000;
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    try {
      const { local, prepare } = await ready(() => now);
      const saves = (): number =>
        (stub?.calls ?? []).filter((call) => call.query === '?action=save').length;
      await prepare('chat-A');
      local.upstream(TAG)?.watch(30_000).done();
      // Простой короче срока (сон через IDLE_SLEEP_SECONDS, запись — за 45 с до него): не пишем.
      now += (IDLE_SLEEP_SECONDS - 60) * 1000;
      await vi.advanceTimersByTimeAsync(15_000);
      await new Promise((done) => setTimeout(done, 100));
      expect(saves()).toBe(0);
      now += 30_000;
      await vi.advanceTimersByTimeAsync(15_000);
      await vi.waitFor(() => expect(saves()).toBe(1));
      await vi.advanceTimersByTimeAsync(30_000);
      await new Promise((done) => setTimeout(done, 100));
      expect(saves()).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('запрос без метки разговора кеша не трогает', async () => {
    const { prepare } = await ready();
    await prepare(undefined);
    expect(erases()).toBe(0);
  });

  it('запрос без метки после хода чата: кеш чата — на диск, следующий ход чата поднимает его, а не считает слот своим', async () => {
    const { local, prepare } = await ready();
    const action = (name: string): number =>
      (stub?.calls ?? []).filter((call) => call.query === `?action=${name}`).length;
    await prepare('chat-A');
    local.upstream(TAG)?.watch(30_000).done();
    // Проба контура (без метки) перепишет слот своим промптом.
    await prepare(undefined);
    expect(action('save')).toBe(1);
    expect(erases()).toBe(1);
    await prepare('chat-A');
    expect(action('restore')).toBe(1);
    expect(erases()).toBe(1);
  });

  it('спящий сервер не будится сбросом: кеш у него и так пуст', async () => {
    const { prepare } = await ready();
    stub?.sleep();
    await prepare('chat-A');
    expect(erases()).toBe(0);
    expect(stub?.isSleeping()).toBe(true);
    // Разговор запомнен: после пробуждения тот же чат кеш не стирает (он уже пуст).
    await prepare('chat-A');
    expect(erases()).toBe(0);
  });

  it('сервер без каталога слотов (501) запрос не срывает', async () => {
    const { prepare } = await ready();
    await stub?.close();
    stub = undefined;
    await expect(prepare('chat-A')).resolves.toBeUndefined();
  });
});
