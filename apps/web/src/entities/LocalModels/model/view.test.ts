import { describe, it, expect } from 'vitest';
import type {
  CatalogModel,
  HardwareGpu,
  InstalledModel,
  LocalModelsInfo,
  ModelBench,
} from '@agentdeck/contracts/local-models';
import { benchElsewhere } from './benchElsewhere';
import { placementOf } from './placementOf';
import { catalogRows } from './catalogRows';
import { claudeModelOf } from './claudeModelOf';

/**
 * Где модель легла на деле и какую модель берёт «Claude Code на локальной
 * модели». Каталог — две строки из настоящего каталога панели (размеры реестра).
 */

const GB = 1024 ** 3;

const QWEN_27: CatalogModel = {
  tag: 'qwen3.6:27b-coding',
  title: 'Qwen3.6 27B Coding',
  family: 'qwen3.6',
  coding: 'tuned',
  repo: 'unsloth/Qwen3.6-27B-MTP-GGUF',
  quants: [{ id: 'Q4_K_M', file: 'Qwen3.6-27B-Q4_K_M.gguf', sizeBytes: 17_106_773_120 }],
  defaultQuant: 'Q4_K_M',
  arch: { layers: 64, kvLayers: 16, kvHeads: 4, headDim: 256 },
  sizeBytes: 17_106_773_120,
  paramsB: 27,
  activeParamsB: 27,
  kvBytesPerToken: 65_536,
  contextMax: 262_144,
  mtp: true,
  agentic: true,
  custom: false,
  released: '2026-04',
  source: '',
};
const QWEN_4: CatalogModel = {
  ...QWEN_27,
  tag: 'qwen3.5:4b',
  title: 'Qwen3.5 4B',
  family: 'qwen3.5',
  coding: 'general',
  repo: 'unsloth/Qwen3.5-4B-GGUF',
  quants: [{ id: 'Q4_K_M', file: 'Qwen3.5-4B-Q4_K_M.gguf', sizeBytes: 2_740_000_000 }],
  sizeBytes: 2_740_000_000,
  arch: { layers: 32, kvLayers: 8, kvHeads: 4, headDim: 256 },
  paramsB: 4,
  activeParamsB: 4,
  kvBytesPerToken: 32_768,
  mtp: false,
};
const RTX_4090: HardwareGpu = {
  vendor: 'nvidia',
  name: 'NVIDIA GeForce RTX 4090',
  vramGb: 24,
  freeGb: 22.2,
  bandwidthGbs: 1008,
  bandwidthFrom: 'table',
};

const installed = (tag: string): InstalledModel => ({
  tag,
  sizeBytes: 1,
  modifiedAt: '2026-10-07T00:00:00Z',
  known: true,
});

function info(over: {
  installed?: InstalledModel[];
  connectModel?: string;
  claudeModel?: string;
  device?: LocalModelsInfo['device'];
  choices?: LocalModelsInfo['choices'];
  jobs?: LocalModelsInfo['jobs'];
  models?: CatalogModel[];
}): LocalModelsInfo {
  return {
    hardware: { gpus: [RTX_4090], ramGb: 95, platform: 'win32', arch: 'x64', detectedBy: '' },
    catalog: { version: 1, checkedAt: '2026-10', models: over.models ?? [QWEN_27, QWEN_4] },
    installed: over.installed ?? [],
    importable: [],
    jobs: over.jobs ?? [],
    choices: over.choices ?? {},
    connect: { model: over.connectModel ?? '' },
    device: over.device ?? 'gpu',
    claude: { on: Boolean(over.claudeModel), model: over.claudeModel ?? '' },
  } as unknown as LocalModelsInfo;
}

describe('где модель легла на деле', () => {
  it('целиком в видеопамяти — 1; size_vram больше размера не даёт больше 1', () => {
    expect(placementOf({ vramBytes: 17 * GB, sizeBytes: 17 * GB }).gpuShare).toBe(1);
    expect(placementOf({ vramBytes: 21 * GB, sizeBytes: 17 * GB }).gpuShare).toBe(1);
  });

  it('разделена с процессором — доля; на процессоре — 0', () => {
    expect(placementOf({ vramBytes: 8 * GB, sizeBytes: 16 * GB }).gpuShare).toBe(0.5);
    expect(placementOf({ vramBytes: 0, sizeBytes: 16 * GB }).gpuShare).toBe(0);
  });

  it('сервер не назвал размер — по одному факту видеопамяти', () => {
    expect(placementOf({ vramBytes: 5, sizeBytes: 0 }).gpuShare).toBe(1);
    expect(placementOf({ vramBytes: 0, sizeBytes: 0 }).gpuShare).toBe(0);
  });
});

describe('модель для Claude Code', () => {
  it('ничего не скачано — включать нечего', () => {
    expect(claudeModelOf(info({}))).toBe('');
  });

  it('скачанные — рекомендованная из них, а не первая по списку установленных', () => {
    const both = info({ installed: [installed(QWEN_4.tag), installed(QWEN_27.tag)] });
    expect(catalogRows(both).find((row) => row.recommended)?.model.tag).toBe(QWEN_27.tag);
    expect(claudeModelOf(both)).toBe(QWEN_27.tag);
  });

  it('рекомендованная не скачана — первая скачанная', () => {
    expect(claudeModelOf(info({ installed: [installed(QWEN_4.tag)] }))).toBe(QWEN_4.tag);
  });

  it('отданная агентам важнее рекомендации, включённая — важнее всего', () => {
    const all = [installed(QWEN_4.tag), installed(QWEN_27.tag)];
    expect(claudeModelOf(info({ installed: all, connectModel: QWEN_4.tag }))).toBe(QWEN_4.tag);
    expect(
      claudeModelOf(info({ installed: all, connectModel: QWEN_4.tag, claudeModel: 'my-own:7b' })),
    ).toBe('my-own:7b');
  });

  it('выбран процессор — подбор без карты: 27B на процессоре агенту не рекомендуется', () => {
    const cpu = info({ installed: [installed(QWEN_27.tag)], device: 'cpu' });
    const row = catalogRows(cpu).find((item) => item.model.tag === QWEN_27.tag);
    expect(row?.fit.level).toBe('cpu');
    expect(row?.recommended).toBe(false);
  });
});

describe('где снят замер', () => {
  const bench = (over: Partial<ModelBench>): ModelBench => ({
    tokensPerSec: 98.2,
    promptTokensPerSec: 245,
    measuredAt: '2026-10-07T16:49:40Z',
    gpu: 'NVIDIA GeForce RTX 4090',
    ...over,
  });

  it('замер карты при счёте на процессоре подписан картой; на карте — без подписи', () => {
    expect(benchElsewhere(bench({ device: 'gpu' }), 'cpu')).toBe('gpu');
    expect(benchElsewhere(bench({ device: 'gpu' }), 'gpu')).toBeUndefined();
    expect(benchElsewhere(bench({ device: 'cpu', gpu: 'cpu' }), 'gpu')).toBe('cpu');
  });

  it('старый замер без устройства — по имени: карта, если это не «cpu»', () => {
    expect(benchElsewhere(bench({}), 'cpu')).toBe('gpu');
    expect(benchElsewhere(bench({ gpu: 'cpu' }), 'cpu')).toBeUndefined();
  });

  it('строка каталога несёт место замера только когда оно другое', () => {
    const measured = { ...installed(QWEN_27.tag), bench: bench({ device: 'gpu' }) };
    const onCpu = catalogRows(info({ installed: [measured], device: 'cpu' }));
    expect(onCpu.find((row) => row.model.tag === QWEN_27.tag)?.benchOn).toBe('gpu');
    const onGpu = catalogRows(info({ installed: [measured] }));
    expect(onGpu.find((row) => row.model.tag === QWEN_27.tag)?.benchOn).toBeUndefined();
  });
});

describe('строка каталога: выбор квантования и окна', () => {
  // Две квантования: меньшее влезает в 22,2 ГБ при любом окне, большее — нет.
  const TWO_QUANTS: CatalogModel = {
    ...QWEN_27,
    quants: [
      { id: 'Q4_K_M', file: 'q4.gguf', sizeBytes: 17_106_773_120 },
      { id: 'Q8_0', file: 'q8.gguf', sizeBytes: 28_000_000_000 },
    ],
  };
  const rowOf = (over: Parameters<typeof info>[0]) =>
    catalogRows(info({ models: [TWO_QUANTS], ...over }))[0]!;

  it('без записи выбор — умолчание каталога; со скачанным другим — оно', () => {
    expect(rowOf({}).choice).toMatchObject({ quant: 'Q4_K_M', allowPartial: false });
    const q8 = { ...installed(TWO_QUANTS.tag), quant: 'Q8_0', quants: ['Q8_0'] };
    expect(rowOf({ installed: [q8] }).choice.quant).toBe('Q8_0');
  });

  it('сохранённый выбор сильнее подбора; влезание считается для НЕГО, а не для умолчания', () => {
    const row = rowOf({ choices: { [TWO_QUANTS.tag]: { quant: 'Q8_0', context: 32_768 } } });
    expect(row.choice).toEqual({ quant: 'Q8_0', context: 32_768, allowPartial: false });
    expect(row.choiceFit.level).not.toBe('gpu');
    expect(row.choiceFit.needGb).toBeGreaterThan(26);
    // «Рекомендуем» и годность по умолчанию от выбора не зависят.
    expect(row.fit.level).toBe('gpu');
  });

  it('списки пересчитываются друг от друга: большое квантование закрывает большие окна, большое окно — квантование', () => {
    const small = rowOf({ choices: { [TWO_QUANTS.tag]: { quant: 'Q4_K_M', context: 262_144 } } });
    expect(small.quantOptions.find((item) => item.value === 'Q8_0')?.disabled).toBe(true);
    const q8 = rowOf({ choices: { [TWO_QUANTS.tag]: { quant: 'Q8_0', context: 32_768 } } });
    expect(q8.contextOptions.find((item) => item.value === 262_144)?.disabled).toBe(true);
    expect(q8.contextOptions.find((item) => item.value === 8_192)?.block).toBe('agent-min');
    // 128K при Q4_K_M влезает, при Q8_0 — нет: список окон считается от ВЫБРАННОГО квантования.
    expect(q8.contextOptions.find((item) => item.value === 131_072)?.disabled).toBe(true);
    expect(small.contextOptions.find((item) => item.value === 131_072)?.disabled).toBe(false);
  });

  it('квантование, которого нет на диске, — не «скачано»; своё скачанное — да', () => {
    const q4 = { ...installed(TWO_QUANTS.tag), quant: 'Q4_K_M', quants: ['Q4_K_M'] };
    const picked = { choices: { [TWO_QUANTS.tag]: { quant: 'Q8_0', context: 32_768 } } };
    expect(rowOf({ installed: [q4], ...picked }).quantInstalled).toBe(false);
    expect(rowOf({ installed: [q4] }).quantInstalled).toBe(true);
  });

  it('замер при другом окне или квантовании устарел; при том же — нет; старый без полей — unknown', () => {
    const benchOf = (over: Partial<ModelBench>): ModelBench => ({
      tokensPerSec: 50,
      promptTokensPerSec: 200,
      measuredAt: '2026-10-14T00:00:00Z',
      gpu: 'NVIDIA GeForce RTX 4090',
      ...over,
    });
    const withBench = (bench: ModelBench) => ({
      ...installed(TWO_QUANTS.tag),
      quant: 'Q4_K_M',
      quants: ['Q4_K_M'],
      bench,
    });
    const choices = { [TWO_QUANTS.tag]: { quant: 'Q4_K_M', context: 65_536 } };
    const same = rowOf({
      installed: [withBench(benchOf({ context: 65_536, quant: 'Q4_K_M' }))],
      choices,
    });
    expect(same.benchStale).toBeUndefined();
    const other = rowOf({
      installed: [withBench(benchOf({ context: 32_768, quant: 'Q4_K_M' }))],
      choices,
    });
    expect(other.benchStale).toBe('other');
    expect(rowOf({ installed: [withBench(benchOf({}))], choices }).benchStale).toBe('unknown');
  });

  it('перезапуск сервера с новыми настройками доходит до строки', () => {
    const job = {
      id: 'j1',
      kind: 'server',
      target: TWO_QUANTS.tag,
      phase: 'restart',
      state: 'running',
    } as unknown as LocalModelsInfo['jobs'][number];
    expect(rowOf({ jobs: [job] }).serverJob?.phase).toBe('restart');
    expect(rowOf({}).serverJob).toBeUndefined();
  });
});
