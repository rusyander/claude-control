import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  modelCatalogSchema,
  type CatalogModel,
  type HardwareGpu,
  type LocalModelsInfo,
} from '@agentdeck/contracts/local-models';
import { catalogRows } from './catalogRows';

/**
 * Порядок строк каталога (владелец 15.10): сверху лучший выбор — «Рекомендуем», потом
 * влезающие целиком, потом «частично в оперативной памяти», внизу не влезающие; внутри
 * группы — порядок файла каталога. Группа — по готовому подбору строки (`fit`), не по
 * новой метрике. Строки считает настоящий `catalogRows`.
 */

const RTX_4090: HardwareGpu = {
  vendor: 'nvidia',
  name: 'NVIDIA GeForce RTX 4090',
  vramGb: 24,
  freeGb: 22.2,
  bandwidthGbs: 1008,
  bandwidthFrom: 'table',
};

const BASE: CatalogModel = {
  tag: 'base',
  title: 'Base',
  family: 'qwen3.5',
  coding: 'general',
  repo: 'o/r',
  quants: [{ id: 'Q4_K_M', file: 'm.gguf', sizeBytes: 2_740_000_000 }],
  defaultQuant: 'Q4_K_M',
  arch: { layers: 32, kvLayers: 8, kvHeads: 4, headDim: 256 },
  sizeBytes: 2_740_000_000,
  paramsB: 4,
  activeParamsB: 4,
  kvBytesPerToken: 32_768,
  contextMax: 262_144,
  mtp: false,
  agentic: true,
  custom: false,
  released: '2026-04',
  source: '',
};
const sized = (tag: string, gb: number, agentic = true): CatalogModel => ({
  ...BASE,
  tag,
  title: tag,
  agentic,
  quants: [{ id: 'Q4_K_M', file: `${tag}.gguf`, sizeBytes: gb * 1e9 }],
  sizeBytes: gb * 1e9,
});

function info(models: CatalogModel[], device: LocalModelsInfo['device'] = 'gpu'): LocalModelsInfo {
  return {
    hardware: { gpus: [RTX_4090], ramGb: 95, platform: 'win32', arch: 'x64', detectedBy: '' },
    catalog: { version: 1, checkedAt: '2026-10', models },
    installed: [],
    importable: [],
    jobs: [],
    choices: {},
    connect: { model: '' },
    device,
  } as unknown as LocalModelsInfo;
}

const tags = (value: LocalModelsInfo): string[] => catalogRows(value).map((row) => row.model.tag);

describe('порядок строк каталога', () => {
  it('рекомендуемая → целиком в видеопамяти → частично → не влезет; внутри группы — порядок файла', () => {
    // Файл каталога нарочно начинается с не влезающей, как Qwen3-Coder-Next.
    const models = [
      sized('huge-a', 160),
      sized('partial-a', 40),
      sized('fits-tools-off', 3, false),
      sized('fits-a', 9),
      sized('huge-b', 120),
      sized('partial-b', 30),
      sized('fits-b', 5),
    ];
    const rows = catalogRows(info(models));
    const level = Object.fromEntries(rows.map((row) => [row.model.tag, row.fit.level]));
    // Предпосылки: подбор действительно разложил модели по трём уровням.
    expect(level).toMatchObject({ 'huge-a': 'none', 'partial-a': 'partial', 'fits-a': 'gpu' });
    expect(rows[0]?.recommended).toBe(true);
    expect(tags(info(models))).toEqual([
      'fits-a',
      'fits-tools-off',
      'fits-b',
      'partial-a',
      'partial-b',
      'huge-a',
      'huge-b',
    ]);
  });

  it('счёт на процессоре: влезающие в оперативную выше не влезающих', () => {
    // Без инструментов — не рекомендуется: порядок решает только группа «влезает в оперативную».
    const models = [sized('huge', 160), sized('small', 3, false)];
    const rows = catalogRows(info(models, 'cpu'));
    expect(rows.map((row) => [row.model.tag, row.fit.level, row.recommended])).toEqual([
      ['small', 'cpu', false],
      ['huge', 'none', false],
    ]);
  });

  it('настоящий каталог на 4090: сверху Qwen3.8 27B, следом Qwen3.6 27B Coding, Qwen3-Coder-Next не первой', () => {
    const file = resolve(
      import.meta.dirname,
      '../../../../../server/src/domains/local-models/data/catalog.json',
    );
    const catalog = modelCatalogSchema.parse(JSON.parse(readFileSync(file, 'utf8')));
    const rows = catalogRows(info(catalog.models));
    expect(rows[0]?.model.tag).toBe('qwen3.8:27b');
    expect(rows[0]?.recommended).toBe(true);
    expect(rows[1]?.model.tag).toBe('qwen3.6:27b-coding');
    const ranks = rows.map((row) => ({ gpu: 1, cpu: 1, partial: 2, none: 3 })[row.fit.level]);
    expect(ranks.slice(1)).toEqual([...ranks.slice(1)].sort((a, b) => a - b));
    // Qwen3-Coder-Next (80B) на 24 ГБ лишь частично — ниже всех, что влезают целиком.
    const next = rows.findIndex((row) => row.model.tag === 'qwen3-coder-next:latest');
    expect(rows[next]?.fit.level).toBe('partial');
    expect(rows.slice(next).every((row) => row.fit.level !== 'gpu')).toBe(true);
    expect(rows[0]?.model.tag).not.toBe('qwen3-coder-next:latest');
  });
});
