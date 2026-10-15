import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { createLocalModels, loadCatalog } from './service.ts';
import { localPaths, updateState } from './paths.ts';
import { readRecord } from './server.ts';
import { modelFilePath } from './hf.ts';
import type { FetchLike } from './download.ts';
import type { KvCacheType } from '@agentdeck/contracts/local-models';

/**
 * Сервер, не влезший в карту (L9, живой разбор 15.10): Qwen3.8 при 131072 поднялся с
 * q8_0, потому что подбор засчитал нашему серверу свою оценку (23,2 ГиБ) поверх
 * свободного, а Windows вытеснил 1,4 ГиБ в общую память — 0,6 ток/с. Теперь засчитывается
 * замер процесса, вытеснение снимает закрепление подобранного кеша и ждёт перезапуска.
 * Сервис, подбор и запись — настоящие; подменены сеть, запуск процесса и ответы утилит
 * (числа — с той же машины).
 */

interface Stubs {
  writeGguf: (path: string, options?: Record<string, unknown>) => Buffer;
}
const REPO = resolve(import.meta.dirname, '..', '..', '..', '..', '..');
const stubs = (await import(
  pathToFileURL(join(REPO, 'tools', 'qa', 'stub-llama.mjs')).href
)) as Stubs;

const Q38 = 'qwen3.8:27b';
const PORT = 11_497;
const MIB = 1024 ** 2;

let root: string;
let up: boolean;
let nextPid: number;
let spawned: string[][];
/** Свободно на карте, МиБ — как скажет nvidia-smi. */
let freeMib: number;
/**
 * Свободно, как скажет CUDA (`llama-server --list-devices`): под WDDM она считает память
 * нашего же сервера свободной — живой замер 15.10: 21208 МиБ при 823 у nvidia-smi.
 */
let cudaFreeMib: number;
/** Что держит процесс: на карте и в общей памяти, байт; по номеру процесса. */
let held: Map<number, { dedicated: number; shared: number }>;

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

function counters(script: string): string {
  const pid = Number(/pid_(\d+)_/.exec(script)?.[1]);
  const own = held.get(pid);
  if (!own) return '';
  const path = `\\\\h\\gpu process memory(pid_${pid}_luid_0x0_0x17d79_phys_0)`;
  return `${path}\\dedicated usage=${own.dedicated}\r\n${path}\\shared usage=${own.shared}\r\n`;
}

function service() {
  return createLocalModels({
    appRoot: root,
    env: ENV(),
    os: 'win32',
    port: PORT,
    fetchImpl: net,
    run: async (cmd, args) => {
      if (args.includes('--list-devices'))
        return `Available devices:\n  CUDA0: NVIDIA GeForce RTX 4090 (24563 MiB, ${cudaFreeMib} MiB free)\n`;
      if (cmd === 'nvidia-smi' && args.includes('--query-gpu=memory.free')) return `${freeMib}\n`;
      if (cmd === 'nvidia-smi') return `NVIDIA GeForce RTX 4090, 24564, ${freeMib}\n`;
      if (cmd === 'powershell.exe' && args.join(' ').includes('GPU Process Memory'))
        return counters(args.join(' '));
      throw new Error(`no ${cmd}`);
    },
    spawnServer: ((_binary: string, args: string[]) => {
      spawned.push(args);
      up = true;
      const pid = nextPid++;
      return { pid, once: () => undefined, unref: () => undefined };
    }) as unknown as Parameters<typeof createLocalModels>[0]['spawnServer'],
    kill: () => {
      up = false;
    },
  });
}

function seed(): void {
  const model = loadCatalog().models.find((item) => item.tag === Q38);
  // Квантование владельца: с ним q8_0 при 131072 не влезает (с умолчанием IQ4_XS влезает честно).
  const quant = model?.quants.find((item) => item.id === 'UD-Q4_K_XL');
  if (!model || !quant) throw new Error(`${Q38} not in catalog`);
  stubs.writeGguf(modelFilePath(localPaths(root, ENV()), model.repo, quant.file), { nextn: 1 });
}

/**
 * Сервер на q8_0 при 131072 — так, как его поднял подбор утром: карта была почти
 * свободна. Затем он «живёт»: свободно 528 МиБ, процесс держит `dedicated` и `shared`.
 */
async function q8Server(dedicated: number, shared: number, kvCache?: KvCacheType) {
  const paths = localPaths(root, ENV());
  updateState(paths, (state) => {
    state.choices[Q38] = { context: 131_072, ...(kvCache ? { kvCache } : {}) };
  });
  freeMib = 24_400;
  cudaFreeMib = 24_400;
  const first = service();
  await first.startServer({ tag: Q38 });
  const record = readRecord(paths);
  expect(record?.kvCache).toBe('q8_0');
  freeMib = 528;
  cudaFreeMib = 21_208;
  held.set(record?.pid ?? 0, { dedicated, shared });
  // Шаблон в записи — нынешний: перезапуск ждёт только из-за памяти.
  spawned = [];
  return { paths, pid: record?.pid };
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'cc-local-spill-'));
  up = false;
  nextPid = 9_000;
  spawned = [];
  held = new Map();
  freeMib = 22_868;
  cudaFreeMib = 22_868;
  const runtimeDir = join(localPaths(root, ENV()).runtime, 'llama-b11583');
  mkdirSync(runtimeDir, { recursive: true });
  // Подбор назван Windows: бинарь — с расширением, где бы тест ни шёл.
  writeFileSync(join(runtimeDir, 'llama-server.exe'), '');
  writeFileSync(join(runtimeDir, 'llama-server'), '');
  seed();
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('сервер вытеснен в общую память', () => {
  it('замер видит вытеснение — перезапуск ждёт конца прогонов и кладёт кеш q4_0', async () => {
    const { paths } = await q8Server(22_847_451_136, 1_526_726_656);
    const local = service();
    // Свободное — по драйверу (528 МиБ), не по CUDA (21208: она считает наш сервер
    // свободным), и сверху то, что процесс держит на карте (21,3 ГиБ), а не оценка запуска
    // (23,2). Любая из прежних ошибок упирала бы «свободно» в объём карты.
    const gpu = (await local.refreshHardware()).gpus[0];
    expect(gpu?.freeGb).toBeCloseTo((528 * MIB + 22_847_451_136) / 1024 ** 3, 1);
    expect(local.restartPending()).toBe(true);
    expect(await local.applyPending()).toBe(true);
    expect(spawned).toHaveLength(1);
    const record = readRecord(paths);
    expect(record?.kvCache).toBe('q4_0');
    expect(record?.context).toBe(131_072);
  });

  it('без вытеснения — ждать нечего, подобранный q8_0 остаётся', async () => {
    const { paths } = await q8Server(22_847_451_136, 200 * MIB);
    const local = service();
    await local.refreshHardware();
    expect(local.restartPending()).toBe(false);
    await local.startServer({ tag: Q38 });
    expect(spawned).toHaveLength(0);
    expect(readRecord(paths)?.kvCache).toBe('q8_0');
  });

  it('q8_0 назван человеком — перезапуска нет: подбор его не меняет', async () => {
    await q8Server(22_847_451_136, 1_526_726_656, 'q8_0');
    const local = service();
    await local.refreshHardware();
    expect(local.restartPending()).toBe(false);
  });

  it('замера нет (чужой язык счётчиков) — подбор на оценке, как раньше', async () => {
    const { paths, pid } = await q8Server(0, 0);
    held.delete(pid ?? 0);
    const local = service();
    await local.refreshHardware();
    expect(local.restartPending()).toBe(false);
    await local.startServer({ tag: Q38 });
    expect(readRecord(paths)?.kvCache).toBe('q8_0');
  });
});
