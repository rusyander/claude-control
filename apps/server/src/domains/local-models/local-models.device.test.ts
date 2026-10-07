import { describe, it, expect } from 'vitest';
import {
  deviceGpu,
  fitModel,
  heldVramBytes,
  modelNeedGb,
  OLLAMA_GPU_RESERVE_GB,
  recommendModel,
  TARGET_CONTEXT,
  usableVramGb,
  withOwnHeldVram,
  type HardwareGpu,
} from '@agentdeck/contracts/local-models';
import { loadCatalog, loadGpuTable } from './service.ts';
import { appleBandwidth, detectGpus, parseAppleSysctl } from './hardware.ts';
import { localPaths } from './paths.ts';
import { CPU_ONLY_ENV, serverEnv } from './server.ts';

/**
 * Где считает модель: видеокарта по умолчанию, процессор по выбору — и учёт
 * памяти, которую держит наш же сервер. Модели — из настоящего каталога панели.
 */

const catalog = loadCatalog().models;
const qwen27 = catalog.find((model) => model.tag === 'qwen3.6:27b-coding');
if (!qwen27) throw new Error('qwen3.6:27b-coding нет в каталоге');

const RTX_4090: HardwareGpu = {
  vendor: 'nvidia',
  name: 'NVIDIA GeForce RTX 4090',
  vramGb: 24,
  freeGb: 22.2,
  bandwidthGbs: 1008,
  bandwidthFrom: 'table',
};
const GB = 1024 ** 3;
/** Свободно на 4090 при фоне 1696 из 24564 МиБ (замер 07.10). */
const IDLE_FREE_GB = Math.round(((24_564 - 1_696) / 1024) * 10) / 10;

describe('видеопамять нашего же сервера', () => {
  it('загруженная 27B не «съедает» свою память: подбор снова видит карту целиком', () => {
    // Живой снимок 07.10: модель держит 17,6 ГБ, свободно 0,7 ГБ.
    const busy = { ...RTX_4090, freeGb: 0.7 };
    expect(fitModel(qwen27, busy, 95).level).toBe('partial');
    const loaded = [
      { tag: 'qwen3.6:27b-coding', vramBytes: 17_573_148_097, sizeBytes: 17_573_148_097 },
    ];
    const held = heldVramBytes(loaded, catalog, 98_304);
    // `size_vram` занижает: берётся наша оценка при контексте сервера.
    expect(held).toBeGreaterThan(17_573_148_097);
    const credited = withOwnHeldVram(busy, held);
    const fit = fitModel(qwen27, credited, 95);
    expect(fit.level).toBe('gpu');
    expect(fit.context).toBe(131_072);
    expect(fit.agentReady).toBe(true);
  });

  it('модель, разделённая с процессором, засчитывается своей долей на карте, не оценкой', () => {
    const split = [{ tag: 'qwen3.6:27b-coding', vramBytes: 8 * GB, sizeBytes: 17 * GB }];
    expect(heldVramBytes(split, catalog, 98_304)).toBe(8 * GB);
    const foreign = [{ tag: 'my-own:7b', vramBytes: 5 * GB, sizeBytes: 5 * GB }];
    expect(heldVramBytes(foreign, catalog, 98_304)).toBe(5 * GB);
  });

  it('больше всей карты не прибавляется; у общей памяти Apple и без замера — как было', () => {
    expect(withOwnHeldVram({ ...RTX_4090, freeGb: 20 }, 40 * GB).freeGb).toBe(24);
    const apple: HardwareGpu = { ...RTX_4090, vendor: 'apple', unified: true, vramGb: 36 };
    expect(withOwnHeldVram(apple, 10 * GB)).toBe(apple);
    const { freeGb: _drop, ...noFree } = RTX_4090;
    expect(withOwnHeldVram(noFree, 10 * GB)).toEqual(noFree);
  });
});

describe('запас видеопамяти — по живому замеру, а не впритык', () => {
  it('27B на 4090 при 22,3 ГБ свободных: q8_0 не дотягивает 131072, который сползал на процессор', () => {
    // Замер 07.10: фон 1696 из 24564 МиБ. Оценка «впритык» дала 131072 на q8_0, сервер
    // поднялся с ним, и Ollama положил на карту 15,1 из 17,6 ГиБ — 4,4 ток/с вместо 107.
    expect(modelNeedGb(qwen27, 131_072) + OLLAMA_GPU_RESERVE_GB).toBeGreaterThan(IDLE_FREE_GB);
    expect(modelNeedGb(qwen27, 98_304) + OLLAMA_GPU_RESERVE_GB).toBeLessThanOrEqual(IDLE_FREE_GB);
  });

  it('при 98304 оценка не меньше занятого на деле: 21,1 ГиБ сверх фона', () => {
    expect(modelNeedGb(qwen27, 98_304)).toBeGreaterThanOrEqual(21.1);
  });

  it('загруженная модель засчитывается тем, что держит, без запаса Ollama — каталог не обещает 128K', () => {
    // Живой снимок 07.10 при сервере на 98304: занято 23412 из 24564 МиБ.
    const busy = { ...RTX_4090, freeGb: Math.round(((24_564 - 23_412) / 1024) * 10) / 10 };
    const loaded = [
      { tag: 'qwen3.6:27b-coding', vramBytes: 17_573_148_097, sizeBytes: 17_573_148_097 },
    ];
    const credited = withOwnHeldVram(busy, heldVramBytes(loaded, catalog, 98_304));
    expect(fitModel(qwen27, credited, 95).context).toBe(131_072);
  });
});

describe('рабочий стол Windows уступает видеопамять модели', () => {
  // Замер 08.10: Figma, Chrome, Docker держали 4,1 ГБ из 24 — подбор по «свободно»
  // давал 27B 16K, а сервер на 131072 с q4_0 встал на карту целиком, 120 ток/с.
  const desktop = { ...RTX_4090, freeGb: Math.round(((24_564 - 4_172) / 1024) * 10) / 10 };

  it('на Windows занятое рабочим столом не режет контекст: 27B получает 128K', () => {
    expect(fitModel(qwen27, { ...desktop, pageable: true }, 95)).toMatchObject({
      level: 'gpu',
      context: TARGET_CONTEXT,
      kvCache: 'q4_0',
    });
  });

  it('без вытеснения (Linux) свободное — жёсткий предел', () => {
    expect(usableVramGb(desktop)).toBe(desktop.freeGb);
    expect(fitModel(qwen27, desktop, 95).context).toBeLessThan(TARGET_CONTEXT);
  });

  it('вытеснение не обещает больше карты за вычетом стола и не урезает настоящее свободное', () => {
    expect(usableVramGb({ ...desktop, pageable: true })).toBeCloseTo(24 - 2.4, 5);
    expect(usableVramGb({ ...RTX_4090, freeGb: 23, pageable: true })).toBe(23);
  });

  it('nvidia-smi на Windows помечает карту вытесняемой, на Linux — нет', async () => {
    const run = async (): Promise<string> => 'NVIDIA GeForce RTX 4090, 24564, 20392';
    const table = loadGpuTable().gpus;
    const win = await detectGpus({ run, platform: 'win32', table });
    const linux = await detectGpus({ run, platform: 'linux', table });
    expect(win.gpus[0]?.pageable).toBe(true);
    expect(linux.gpus[0]?.pageable).toBeUndefined();
  });
});

describe('кеш контекста: q8_0 по умолчанию, q4_0 — ради более длинного контекста', () => {
  const idle = { ...RTX_4090, freeGb: IDLE_FREE_GB };

  it('27B на 4090: 131072 на q4_0 целиком на карте — вместо 98304 на q8_0', () => {
    // Замер 07.10: q4_0 при 131072 — 20,75 ГиБ сверх фона, вся модель на карте, 100,8 ток/с.
    const fit = fitModel(qwen27, idle, 95);
    expect(fit).toMatchObject({ level: 'gpu', context: TARGET_CONTEXT, kvCache: 'q4_0' });
    expect(fit.needGb).toBeGreaterThanOrEqual(20.75);
    expect(modelNeedGb(qwen27, TARGET_CONTEXT, 'q4_0')).toBeLessThan(
      modelNeedGb(qwen27, TARGET_CONTEXT),
    );
  });

  it('модель, которой q8_0 и так хватает на 128K, сжатия не получает', () => {
    const small = catalog.find((model) => model.tag === 'qwen3.5:9b');
    if (!small) throw new Error('qwen3.5:9b нет в каталоге');
    expect(fitModel(small, idle, 95)).toMatchObject({ context: TARGET_CONTEXT, kvCache: 'q8_0' });
  });

  it('q4_0 не дотягивает до 128K — всё равно берётся, если даёт контекст длиннее q8_0', () => {
    // Владелец 08.10: 16K агенту мало. При 20 ГБ свободных q8_0 дал бы 27B лишь 32K.
    const big = fitModel(qwen27, { ...RTX_4090, freeGb: 20 }, 95);
    expect(fitModel(qwen27, { ...RTX_4090, freeGb: 20, pageable: false }, 95).context).toBe(
      big.context,
    );
    expect(big.kvCache).toBe('q4_0');
    expect(big.context).toBeGreaterThan(32_768);
    expect(big.context).toBeLessThan(TARGET_CONTEXT);
    expect(modelNeedGb(qwen27, big.context, 'q8_0') + OLLAMA_GPU_RESERVE_GB).toBeGreaterThan(20);
  });

  it('q8_0 даёт тот же контекст, что q4_0, — кеш не сжимается', () => {
    const card16 = { ...RTX_4090, vramGb: 16, freeGb: 4 };
    const small = catalog.find((model) => model.tag === 'qwen3.5:9b');
    if (!small) throw new Error('qwen3.5:9b нет в каталоге');
    const fit = fitModel(small, { ...card16, freeGb: 15 }, 95);
    expect(fit).toMatchObject({ context: TARGET_CONTEXT, kvCache: 'q8_0' });
  });

  it('модель, поднятая на q4_0, засчитывается по q4_0 — подбор не прыгает обратно', () => {
    const busy = { ...RTX_4090, freeGb: 1.1 };
    const loaded = [
      { tag: 'qwen3.6:27b-coding', vramBytes: 17_573_148_097, sizeBytes: 17_573_148_097 },
    ];
    const held = heldVramBytes(loaded, catalog, TARGET_CONTEXT, 'q4_0');
    expect(held).toBeLessThan(heldVramBytes(loaded, catalog, TARGET_CONTEXT));
    expect(fitModel(qwen27, withOwnHeldVram(busy, held), 95)).toMatchObject({
      context: TARGET_CONTEXT,
      kvCache: 'q4_0',
    });
  });

  it('сервер получает выбранный кеш; без выбора — q8_0', () => {
    const paths = localPaths('C:/app', {});
    const q4 = serverEnv({
      paths,
      port: 11435,
      context: TARGET_CONTEXT,
      kvCache: 'q4_0',
      base: {},
    });
    expect(q4.OLLAMA_KV_CACHE_TYPE).toBe('q4_0');
    expect(q4.OLLAMA_CONTEXT_LENGTH).toBe(String(TARGET_CONTEXT));
    const plain = serverEnv({ paths, port: 11435, context: 32_768, base: {} });
    expect(plain.OLLAMA_KV_CACHE_TYPE).toBe('q8_0');
  });
});

describe('счёт на процессоре', () => {
  it('выбран процессор — подбор без карты, даже если она есть', () => {
    const hardware = { gpus: [RTX_4090] };
    expect(deviceGpu(hardware, 'gpu')).toBe(RTX_4090);
    expect(deviceGpu(hardware, 'cpu')).toBeUndefined();
  });

  it('27B на процессоре ложится в оперативную целиком, но агенту медленно', () => {
    const fit = fitModel(qwen27, undefined, 95);
    expect(fit.level).toBe('cpu');
    expect(fit.offloadGb).toBe(fit.needGb);
    // Замер 07.10 на Ryzen 9 7950X: 3,9 ток/с — оценка должна быть того же порядка.
    expect(fit.tokensPerSec[0]).toBeGreaterThanOrEqual(1);
    expect(fit.tokensPerSec[1]).toBeLessThanOrEqual(8);
    expect(fit.agentReady).toBe(false);
    expect(fit.reason).toBe('cpu-slow');
  });

  it('оперативной мало — «не влезет», а не обещание', () => {
    const fit = fitModel(qwen27, undefined, 16);
    expect(fit.level).toBe('none');
    expect(fit.reason).toBe('too-big');
  });

  it('на процессоре рекомендуется только то, что даст агенту темп', () => {
    const best = recommendModel(catalog, undefined, 95);
    if (best) expect(best.fit.tokensPerSec[0]).toBeGreaterThanOrEqual(8);
  });

  it('сервер на процессоре прячет карты всех движков; на видеокарте — не прячет', () => {
    const paths = localPaths('C:/app', {});
    const cpu = serverEnv({ paths, port: 11435, context: 32_768, device: 'cpu', base: {} });
    for (const [key, value] of Object.entries(CPU_ONLY_ENV)) expect(cpu[key]).toBe(value);
    expect(CPU_ONLY_ENV.CUDA_VISIBLE_DEVICES).toBe('-1');
    const gpu = serverEnv({ paths, port: 11435, context: 32_768, device: 'gpu', base: {} });
    for (const key of Object.keys(CPU_ONLY_ENV)) expect(gpu[key]).toBeUndefined();
  });
});

describe('чипы Apple M — по поколению и уровню', () => {
  const table = loadGpuTable().gpus;
  const sysctl = (brand: string, gb: number): string => `${brand}\n${gb * GB}\n`;

  it('известный чип — из справочника; объединённая память', () => {
    const [m4pro] = parseAppleSysctl(sysctl('Apple M4 Pro', 48), table);
    expect(m4pro).toMatchObject({ vendor: 'apple', unified: true, vramGb: 48 });
    expect(m4pro).toMatchObject({ bandwidthGbs: 273, bandwidthFrom: 'table' });
  });

  it('M5 Pro, которого нет в справочнике, — не строка базового M5, а прикидка по M4 Pro', () => {
    const [m5pro] = parseAppleSysctl(sysctl('Apple M5 Pro', 48), table);
    expect(m5pro).toMatchObject({ bandwidthGbs: 273, bandwidthFrom: 'guess' });
    const [m5] = parseAppleSysctl(sysctl('Apple M5', 16), table);
    expect(m5).toMatchObject({ bandwidthGbs: 153, bandwidthFrom: 'table' });
  });

  it('будущие M6 и M7 — новейшее известное поколение того же уровня', () => {
    expect(appleBandwidth('Apple M7', table)).toEqual({
      bandwidthGbs: 153,
      bandwidthFrom: 'guess',
    });
    expect(appleBandwidth('Apple M6 Max', table)).toEqual({
      bandwidthGbs: 410,
      bandwidthFrom: 'guess',
    });
    expect(appleBandwidth('Apple M6 Ultra', table)?.bandwidthGbs).toBe(819);
  });

  it('модель на Mac считается на общей памяти: 27B ложится на M4 Max 64 ГБ', () => {
    const [m4max] = parseAppleSysctl(sysctl('Apple M4 Max', 64), table);
    if (!m4max) throw new Error('no chip');
    const fit = fitModel(qwen27, m4max, 64);
    expect(fit.level).toBe('gpu');
    expect(fit.agentReady).toBe(true);
  });
});
