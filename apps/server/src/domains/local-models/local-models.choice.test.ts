import { describe, it, expect } from 'vitest';
import {
  AGENT_MIN_CONTEXT,
  GPU_RESERVE_GB,
  benchStale,
  catalogModelSchema,
  contextOptions,
  contextStepsFor,
  fitChoice,
  fitModel,
  modelNeedGb,
  quantName,
  quantQuality,
  isLowQuality,
  recommendChoice,
  quantOptions,
  resolveChoice,
  withInstalledQuant,
  type CatalogModel,
  type HardwareGpu,
} from '@agentdeck/contracts/local-models';

/**
 * Выбор квантования и окна — арифметика из контрактов, ни одной копии на экране
 * или сервере. Модель синтетическая: размеры подобраны так, чтобы границы
 * «влезает впритык» и «кеш q4_0 вместо q8_0» лежали на круглых числах.
 */

const GIB = 1024 ** 3;

function modelOf(extra: Record<string, unknown> = {}): CatalogModel {
  return catalogModelSchema.parse({
    tag: 'test:30b',
    title: 'Test 30B',
    family: 'test',
    coding: 'general',
    repo: 'acme/Test-GGUF',
    quants: [
      { id: 'Q2_K', file: 'Test-Q2_K.gguf', sizeBytes: 6 * GIB },
      { id: 'Q4_K_M', file: 'Test-Q4_K_M.gguf', sizeBytes: 10 * GIB },
      { id: 'Q6_K', file: 'Test-Q6_K.gguf', sizeBytes: 14 * GIB },
      { id: 'Q8_0', file: 'Test-Q8_0.gguf', sizeBytes: 18 * GIB },
    ],
    defaultQuant: 'Q4_K_M',
    paramsB: 30,
    activeParamsB: 30,
    // 16 слоёв с кешем × 2 × 4 головы × 256 × 2 байта = 65 536 Б на токен при f16.
    arch: { layers: 64, kvLayers: 16, kvHeads: 4, headDim: 256 },
    contextMax: 262_144,
    agentic: true,
    ...extra,
  });
}

function gpuWith(freeGb: number): HardwareGpu {
  return {
    vendor: 'nvidia',
    name: 'Test GPU',
    vramGb: 24,
    freeGb,
    bandwidthGbs: 1000,
    bandwidthFrom: 'table',
  };
}

const RAM = 64;

describe('fitChoice: влезают ли ЭТО квантование и ЭТО окно, при свободной сейчас памяти', () => {
  it('впритык: свободно ровно «нужно + запас» — влезает, на 0,01 ГБ меньше — нет (границей служит кеш q4_0)', () => {
    const model = modelOf();
    const pick = { quant: 'Q4_K_M', context: 262_144 };
    const need8 = modelNeedGb(model, pick.context, 'q8_0', pick.quant);
    const need4 = modelNeedGb(model, pick.context, 'q4_0', pick.quant);
    const exactly = fitChoice(model, gpuWith(need4 + GPU_RESERVE_GB), RAM, pick);
    expect(exactly).toMatchObject({ level: 'gpu', fits: true, allowed: true, kvCache: 'q4_0' });
    expect(exactly.needGb).toBeCloseTo(need4, 6);
    expect(exactly.availableGb).toBeCloseTo(need4 + GPU_RESERVE_GB, 6);

    const short = fitChoice(model, gpuWith(need4 + GPU_RESERVE_GB - 0.01), RAM, pick);
    expect(short.fits).toBe(false);
    expect(short.level).not.toBe('gpu');
    // Граница q8_0 лежит выше: ровно на ней кеш ещё q8_0, чуть ниже — уже q4_0.
    expect(fitChoice(model, gpuWith(need8 + GPU_RESERVE_GB), RAM, pick).kvCache).toBe('q8_0');
    expect(fitChoice(model, gpuWith(need8 + GPU_RESERVE_GB - 0.01), RAM, pick).kvCache).toBe(
      'q4_0',
    );
  });

  it('вес — размер файла выбранного квантования: то же окно, другой файл — другая память', () => {
    const model = modelOf();
    const small = fitChoice(model, gpuWith(24), RAM, { quant: 'Q2_K', context: 32_768 });
    const big = fitChoice(model, gpuWith(24), RAM, { quant: 'Q8_0', context: 32_768 });
    expect(big.needGb - small.needGb).toBeCloseTo(12, 6);
  });

  it('тип кеша: q8_0, пока влезает; не влезает — q4_0, и память считается по нему', () => {
    const model = modelOf();
    const pick = { quant: 'Q6_K', context: 131_072 };
    const need8 = modelNeedGb(model, pick.context, 'q8_0', pick.quant);
    const need4 = modelNeedGb(model, pick.context, 'q4_0', pick.quant);
    expect(need4).toBeLessThan(need8);
    // Между двумя нуждами: q8_0 уже не влезает, q4_0 ещё да.
    const between = fitChoice(model, gpuWith((need8 + need4) / 2 + GPU_RESERVE_GB), RAM, pick);
    expect(between).toMatchObject({ level: 'gpu', kvCache: 'q4_0' });
    expect(between.needGb).toBeCloseTo(need4, 6);
    // С запасом — q8_0 и бóльшая цифра.
    const roomy = fitChoice(model, gpuWith(need8 + GPU_RESERVE_GB + 1), RAM, pick);
    expect(roomy).toMatchObject({ level: 'gpu', kvCache: 'q8_0' });
    expect(roomy.needGb).toBeCloseTo(need8, 6);
  });

  it('частично: открыто только разрешённым человеком и показывает падение скорости', () => {
    const model = modelOf();
    const pick = { quant: 'Q8_0', context: 65_536 };
    const whole = fitChoice(model, gpuWith(60), RAM, pick);
    const need = modelNeedGb(model, pick.context, 'q8_0', pick.quant);
    const free = need - 4;
    const refused = fitChoice(model, gpuWith(free), RAM, pick, false);
    // Частично — с кешем q4_0 (L9): q8_0 тем более не влез, и меньший кеш оставляет на карте слои.
    expect(refused).toMatchObject({
      level: 'partial',
      fits: false,
      allowed: false,
      kvCache: 'q4_0',
    });
    const need4 = modelNeedGb(model, pick.context, 'q4_0', pick.quant);
    expect(refused.needGb).toBeCloseTo(need4, 6);
    expect(refused.offloadGb).toBeCloseTo(need4 - free + GPU_RESERVE_GB, 6);
    expect(refused.offloadGb).toBeLessThan(4 + GPU_RESERVE_GB);
    const allowed = fitChoice(model, gpuWith(free), RAM, pick, true);
    expect(allowed).toMatchObject({ level: 'partial', allowed: true, agentReady: false });
    expect(allowed.tokensPerSec[1]).toBeLessThan(whole.tokensPerSec[1]);
    expect(allowed.reason).toBe('partial');
  });

  it('не влезает и в оперативную память — none, даже с разрешением', () => {
    const model = modelOf();
    const fit = fitChoice(model, gpuWith(2), 8, { quant: 'Q8_0', context: 262_144 }, true);
    expect(fit).toMatchObject({ level: 'none', allowed: false, reason: 'too-big' });
  });

  it('карты нет: счёт в оперативной памяти по её бюджету, скорость — оперативной памяти', () => {
    const model = modelOf();
    const pick = { quant: 'Q4_K_M', context: 32_768 };
    const fit = fitChoice(model, undefined, RAM, pick);
    expect(fit).toMatchObject({ level: 'cpu', fits: true });
    expect(fit.availableGb).toBeCloseTo(RAM * 0.75 - 4, 6);
    expect(fitChoice(model, undefined, 8, pick)).toMatchObject({ level: 'none', fits: false });
  });

  it('согласуется с fitModel: подобранное окно при тех же квантовании и карте даёт тот же уровень и кеш', () => {
    const model = modelOf();
    const gpu = gpuWith(20);
    const auto = fitModel(model, gpu, RAM, 'Q4_K_M');
    const chosen = fitChoice(model, gpu, RAM, { quant: 'Q4_K_M', context: auto.context });
    expect(chosen).toMatchObject({ level: auto.level, kvCache: auto.kvCache ?? 'q8_0' });
    expect(chosen.needGb).toBeCloseTo(auto.needGb, 6);
  });

  it('агент: окно меньше 32K — не готов; не агентная модель — «без инструментов»', () => {
    const agentic = fitChoice(modelOf(), gpuWith(24), RAM, { quant: 'Q4_K_M', context: 16_384 });
    expect(agentic).toMatchObject({ agentReady: false, reason: 'small-context' });
    const ok = fitChoice(modelOf(), gpuWith(24), RAM, {
      quant: 'Q4_K_M',
      context: AGENT_MIN_CONTEXT,
    });
    expect(ok.agentReady).toBe(true);
    const plain = fitChoice(modelOf({ agentic: false }), gpuWith(24), RAM, {
      quant: 'Q4_K_M',
      context: 65_536,
    });
    expect(plain).toMatchObject({ agentReady: false, reason: 'no-tools' });
  });
});

describe('селекторы пересчитывают друг друга в обе стороны', () => {
  const model = modelOf();
  const gpu = gpuWith(20);

  it('квантование → окно: выбрали крупное — длинные окна закрылись, выбрали мелкое — открылись', () => {
    const onSmall = contextOptions(model, gpu, RAM, 'Q2_K');
    const onBig = contextOptions(model, gpu, RAM, 'Q8_0');
    const at = (options: typeof onSmall, value: number) =>
      options.find((option) => option.value === value);
    expect(at(onSmall, 262_144)?.disabled).toBe(false);
    expect(at(onBig, 262_144)).toMatchObject({ disabled: true, block: 'too-big' });
    // Причина несёт цифры: сколько нужно и сколько есть.
    const big = at(onBig, 262_144);
    expect(big?.needGb).toBeGreaterThan(big?.availableGb ?? 0);
    expect(big?.availableGb).toBeCloseTo(20, 6);
  });

  it('окно → квантование: выбрали длинное окно — крупные файлы закрылись, короткое — открылись', () => {
    const atLong = quantOptions(model, gpu, RAM, 262_144);
    const atShort = quantOptions(model, gpu, RAM, 32_768);
    const id = (options: typeof atLong, quant: string) =>
      options.find((option) => option.value === quant);
    expect(id(atShort, 'Q6_K')?.disabled).toBe(false);
    expect(id(atLong, 'Q6_K')).toMatchObject({ disabled: true, block: 'too-big' });
    // Мелкое остаётся доступным при любом окне, пока влезает.
    expect(id(atLong, 'Q2_K')?.disabled).toBe(false);
    expect(id(atLong, 'Q6_K')?.sizeBytes).toBe(14 * GIB);
  });

  it('граница одна и та же с обеих сторон: пара «влезает» в одном списке ⇔ в другом', () => {
    for (const quant of model.quants) {
      const byContext = contextOptions(model, gpu, RAM, quant.id);
      for (const option of byContext) {
        if (option.value < AGENT_MIN_CONTEXT) continue;
        const byQuant = quantOptions(model, gpu, RAM, option.value).find(
          (item) => item.value === quant.id,
        );
        expect(byQuant?.disabled, `${quant.id} @ ${option.value}`).toBe(option.disabled);
      }
    }
  });

  it('меньше 32K агенту закрыто с причиной; модели без инструментов ограничение ни к чему', () => {
    const options = contextOptions(model, gpu, RAM, 'Q2_K');
    for (const small of [8_192, 16_384])
      expect(options.find((option) => option.value === small)).toMatchObject({
        disabled: true,
        block: 'agent-min',
      });
    expect(options.find((option) => option.value === 32_768)?.disabled).toBe(false);
    const plain = contextOptions(modelOf({ agentic: false }), gpu, RAM, 'Q2_K');
    expect(plain.find((option) => option.value === 8_192)?.disabled).toBe(false);
  });

  it('с разрешением частичной выгрузки закрытые «не влезает» открываются и помечены partial', () => {
    const strict = quantOptions(model, gpu, RAM, 65_536, false).find((o) => o.value === 'Q8_0');
    const loose = quantOptions(model, gpu, RAM, 65_536, true).find((o) => o.value === 'Q8_0');
    expect(strict?.disabled).toBe(true);
    expect(loose).toMatchObject({ disabled: false, partial: true, level: 'partial' });
  });

  it('свободная память живая: освободилась — закрытое открылось, заняли — закрылось', () => {
    const at = (free: number) =>
      quantOptions(model, gpuWith(free), RAM, 65_536).find((o) => o.value === 'Q8_0')?.disabled;
    expect(at(16)).toBe(true);
    expect(at(23)).toBe(false);
    expect(at(16)).toBe(true);
  });
});

describe('шаги окна, выбор по умолчанию, замер', () => {
  it('шаги — от 8K до предела модели; предел вне шага добавляется последним, выше предела шагов нет', () => {
    expect(contextStepsFor({ contextMax: 262_144 })).toEqual([
      8_192, 16_384, 32_768, 49_152, 65_536, 98_304, 131_072, 196_608, 262_144,
    ]);
    expect(contextStepsFor({ contextMax: 40_960 }).at(-1)).toBe(40_960);
    expect(contextStepsFor({ contextMax: 32_768 })).toEqual([8_192, 16_384, 32_768]);
  });

  it('по умолчанию окно — defaultContext каталога, если он влезает', () => {
    const model = modelOf({ defaultContext: 65_536 });
    const picked = resolveChoice(model, gpuWith(24), RAM, undefined);
    expect(picked).toEqual({ quant: 'Q4_K_M', context: 65_536, allowPartial: false });
  });

  it('сохранённое человеком бьёт подбор; неизвестное квантование игнорируется; окно режется пределом', () => {
    const model = modelOf({ defaultContext: 65_536 });
    expect(
      resolveChoice(model, gpuWith(24), RAM, {
        quant: 'Q6_K',
        context: 32_768,
        allowPartial: true,
      }),
    ).toEqual({ quant: 'Q6_K', context: 32_768, allowPartial: true });
    expect(resolveChoice(model, gpuWith(24), RAM, { quant: 'Q9_NOPE' }, 'Q2_K').quant).toBe('Q2_K');
    expect(resolveChoice(model, gpuWith(24), RAM, { context: 4_000_000 }).context).toBe(262_144);
  });

  it('скачанный файл из Ollama считается по настоящему размеру, а не по размеру умолчания', () => {
    const model = modelOf();
    const same = withInstalledQuant(model, { quant: 'Q4_K_M', sizeBytes: 123 });
    expect(same).toBe(model);
    const imported = withInstalledQuant(model, {
      quant: 'Ollama',
      sizeBytes: 12 * GIB,
      quantLabel: 'Q4_K_M',
      source: 'ollama',
    });
    expect(imported.quants.map((quant) => quant.id)).toContain('Ollama');
    // Человеку — настоящее квантование и источник, не служебная метка.
    expect(quantName(imported, 'Ollama')).toBe('Q4_K_M');
    expect(quantName(imported, 'Q4_K_M')).toBe('Q4_K_M');
    expect(
      quantOptions(imported, gpuWith(24), RAM, 32_768).find((option) => option.value === 'Ollama'),
    ).toMatchObject({ label: 'Q4_K_M', source: 'ollama' });
    const need = modelNeedGb(imported, 32_768, 'q8_0', 'Ollama');
    expect(need - modelNeedGb(model, 32_768, 'q8_0', 'Q4_K_M')).toBeCloseTo(2, 6);
  });

  it('замер устарел при другом окне или квантовании; у замера без записи — «неизвестно»', () => {
    const pick = { quant: 'Q4_K_M', context: 65_536 };
    expect(benchStale({ quant: 'Q4_K_M', context: 65_536 }, pick)).toBeUndefined();
    expect(benchStale({ quant: 'Q4_K_M', context: 32_768 }, pick)).toBe('other');
    expect(benchStale({ quant: 'Q8_0', context: 65_536 }, pick)).toBe('other');
    expect(benchStale({}, pick)).toBe('unknown');
    expect(benchStale({ context: 65_536 }, pick)).toBe('unknown');
  });
});

describe('recommendChoice: что рекомендуется на ЭТОЙ машине, по свободной сейчас видеопамяти', () => {
  // 64K по умолчанию: агенту контекст важнее лишней ступени квантования.
  const model = modelOf({ defaultContext: 65_536 });
  const rec = (freeGb: number, over = model) => recommendChoice(over, gpuWith(freeGb), RAM);

  it('разные карты — разные ответы; лучшее целиком на карте, но не выше Q6_K', () => {
    // 3090/4090 с 24 ГБ: Q6_K на 64K. 5090 с 32 ГБ: Q8_0 влез бы, но выше Q6_K выигрыша нет.
    expect(rec(24)).toEqual({ status: 'ok', quant: 'Q6_K', context: 65_536, lowQuality: false });
    expect(rec(32)).toEqual({ status: 'ok', quant: 'Q6_K', context: 65_536, lowQuality: false });
    // 16 ГБ: Q6_K не влезает, берётся Q4_K_M.
    expect(rec(16)).toEqual({ status: 'ok', quant: 'Q4_K_M', context: 65_536, lowQuality: false });
    // 12 ГБ: ни один ≥IQ4_XS не лезет даже на 32K — лучший из Q3 и ниже, с пометкой.
    expect(rec(12)).toEqual({ status: 'ok', quant: 'Q2_K', context: 65_536, lowQuality: true });
    // 6 ГБ: на 32K пусто — рекомендации нет.
    expect(rec(6)).toEqual({ status: 'none' });
  });

  it('не влезло на 64K — окно шагом вниз, а не квантование: 64K → 48K → 32K', () => {
    expect(rec(13.5)).toMatchObject({ quant: 'Q4_K_M', context: 65_536 });
    expect(rec(13.25)).toMatchObject({ quant: 'Q4_K_M', context: 49_152 });
    expect(rec(13)).toMatchObject({ quant: 'Q4_K_M', context: 32_768 });
  });

  it('окно по умолчанию каталога — потолок: больше предела модели не берётся', () => {
    const small = modelOf({ defaultContext: 65_536, contextMax: 40_960 });
    expect(rec(24, small)).toMatchObject({ context: 40_960 });
  });

  it('порядок качества: Q8_0 > Q6_K > Q5_K_M > Q5_K_S > UD-Q4_K_XL > Q4_K_M > Q4_K_S > IQ4_XS > Q3', () => {
    const order = [
      'Q8_0',
      'Q6_K',
      'Q5_K_M',
      'Q5_K_S',
      'UD-Q4_K_XL',
      'Q4_K_M',
      'Q4_K_S',
      'IQ4_XS',
      'Q3_K_L',
    ];
    const scores = order.map((id) => quantQuality(id) ?? -1);
    expect(scores).toEqual([...scores].sort((a, b) => b - a));
    expect(new Set(scores).size).toBe(order.length);
    expect(quantQuality('Q4_K')).toBeDefined();
    expect(quantQuality('что-то-своё')).toBeUndefined();
    expect(['Q2_K', 'IQ2_XS', 'Q3_K_M', 'IQ3_S'].every(isLowQuality)).toBe(true);
    expect(['IQ4_XS', 'Q4_K_M', 'Q8_0'].some(isLowQuality)).toBe(false);
  });

  it('частичная выгрузка рекомендации не меняет: считается только целиком на карте', () => {
    expect(rec(16)).toMatchObject({ quant: 'Q4_K_M' });
    expect(rec(8)).toEqual({ status: 'none' });
  });

  it('только по доступной памяти, не по вендору и названию: объединённая память 128 ГБ, неизвестная пропускная способность, 8 ГБ', () => {
    // Объединённая память (Apple, DGX Spark, Ryzen AI Max): отдаётся около 0,72 от всей.
    const unified: HardwareGpu = {
      vendor: 'apple',
      name: 'какой-то чип',
      vramGb: 128,
      bandwidthGbs: 0,
      bandwidthFrom: 'guess',
      unified: true,
    };
    expect(recommendChoice(model, unified, 128)).toEqual({
      status: 'ok',
      quant: 'Q6_K',
      context: 65_536,
      lowQuality: false,
    });
    // То же число памяти у другого вендора и без «unified» даёт тот же ответ: название не читается.
    const other: HardwareGpu = {
      ...gpuWith(24),
      vendor: 'amd',
      name: 'совсем другая карта',
      bandwidthGbs: 0,
      bandwidthFrom: 'guess',
    };
    expect(recommendChoice(model, other, RAM)).toEqual(rec(24));
    // 8 ГБ: ни один файл модели не лезет целиком даже на 32K.
    expect(rec(8)).toEqual({ status: 'none' });
    // Без карты считает оперативная память.
    expect(recommendChoice(model, undefined, 128)).toMatchObject({ status: 'ok' });
  });
});
