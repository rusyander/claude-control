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
  sizeBytes: 17_769_000_000,
  paramsB: 27,
  activeParamsB: 27,
  kvBytesPerToken: 65_536,
  contextMax: 262_144,
  mtp: true,
  agentic: true,
  ollamaMin: '0.30.0',
  released: '2026-04',
  source: '',
};
const QWEN_4: CatalogModel = {
  ...QWEN_27,
  tag: 'qwen3.5:4b',
  title: 'Qwen3.5 4B',
  family: 'qwen3.5',
  coding: 'general',
  sizeBytes: 3_325_000_000,
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
}): LocalModelsInfo {
  return {
    hardware: { gpus: [RTX_4090], ramGb: 95, platform: 'win32', arch: 'x64', detectedBy: '' },
    catalog: { version: 1, checkedAt: '2026-10', models: [QWEN_27, QWEN_4] },
    installed: over.installed ?? [],
    importable: [],
    jobs: [],
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
