import { beforeAll, describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { LocalModelsInfo } from '@agentdeck/contracts/local-models';
import { i18n } from '@shared/config/i18n';
import { catalogRows } from '@entities/LocalModels';
import { ModelRow } from './ModelRow';

/**
 * Строка каталога под выбор квантования и окна: что она показывает и какие кнопки
 * оставляет. Строка строится настоящим `catalogRows`, а не рукописным объектом.
 */

const MODEL = {
  tag: 'qwen3.6:27b-coding',
  title: 'Qwen3.6 27B Coding',
  family: 'qwen3.6',
  coding: 'tuned',
  repo: 'unsloth/Qwen3.6-27B-MTP-GGUF',
  quants: [
    { id: 'Q4_K_M', file: 'q4.gguf', sizeBytes: 17_106_773_120 },
    { id: 'UD-Q4_K_XL', file: 'q4xl.gguf', sizeBytes: 17_900_000_000 },
  ],
  defaultQuant: 'Q4_K_M',
  arch: { layers: 64, kvLayers: 16, kvHeads: 4, headDim: 256 },
  sizeBytes: 17_106_773_120,
  paramsB: 27,
  activeParamsB: 27,
  kvBytesPerToken: 65_536,
  contextMax: 262_144,
  defaultContext: 65_536,
  mtp: false,
  agentic: true,
  custom: false,
  released: '2026-04',
  source: '',
};

const INSTALLED = {
  tag: MODEL.tag,
  quant: 'Q4_K_M',
  quants: ['Q4_K_M'],
  sizeBytes: 17_106_773_120,
  modifiedAt: '2026-10-14T00:00:00Z',
  known: true,
  bench: {
    tokensPerSec: 61.4,
    promptTokensPerSec: 2210,
    measuredAt: '2026-10-14T00:00:00Z',
    gpu: 'RTX 4090',
    device: 'gpu',
    context: 65_536,
    quant: 'Q4_K_M',
  },
};

function html(over: Partial<LocalModelsInfo> & Record<string, unknown> = {}): string {
  const info = {
    hardware: {
      gpus: [
        {
          vendor: 'nvidia',
          name: 'RTX 4090',
          vramGb: 24,
          freeGb: 22.2,
          bandwidthGbs: 1008,
          bandwidthFrom: 'table',
        },
      ],
      ramGb: 95,
      platform: 'linux',
      arch: 'x64',
      detectedBy: '',
    },
    catalog: { version: 1, checkedAt: '2026-10', models: [MODEL] },
    installed: [INSTALLED],
    importable: [],
    jobs: [],
    connect: { model: '' },
    device: 'gpu',
    choices: {},
    ...over,
  } as unknown as LocalModelsInfo;
  const row = catalogRows(info)[0];
  if (!row) throw new Error('no row');
  return renderToStaticMarkup(
    <ModelRow
      row={row}
      inUse={false}
      serverReady
      busy={{ pull: false, bench: false, connect: false }}
      onPull={() => undefined}
      onImport={() => undefined}
      onConnect={() => undefined}
      onBench={() => undefined}
      onRemove={() => undefined}
      onCancel={() => undefined}
      onChoose={() => undefined}
    />,
  );
}

beforeAll(async () => {
  await i18n.changeLanguage('ru');
});

describe('ModelRow: выбор квантования и окна', () => {
  it('скачанное выбранное квантование: «Замерить» и «Отдать агентам» есть, «Скачать» нет', () => {
    const out = html();
    expect(out).toContain('Замерить');
    expect(out).toContain('Отдать агентам');
    expect(out).not.toContain('Скачать');
    // Замер снят при том же выборе — устаревшим не помечен, подписан окном и квантованием.
    expect(out).not.toContain('замер снят при другом');
    expect(out).toContain('64K, Q4_K_M');
  });

  it('выбрано квантование без файла: кнопка «Скачать» с названием и размером; «Замерить» и «Отдать агентам» скрыты', () => {
    const out = html({ choices: { [MODEL.tag]: { quant: 'UD-Q4_K_XL', context: 65_536 } } });
    expect(out).toMatch(/Скачать UD-Q4_K_XL\s*·\s*16,7/);
    expect(out).not.toContain('Замерить');
    expect(out).not.toContain('Отдать агентам');
    expect(out).toContain('Файла UD-Q4_K_XL нет на диске');
    expect(out).toContain('на диске: Q4_K_M');
    // Замер снят при Q4_K_M, выбрано другое — устарел.
    expect(out).toContain('замер снят при другом выборе');
  });

  it('смена окна: строка пишет новое окно, а замер при другом окне устарел', () => {
    const out = html({ choices: { [MODEL.tag]: { quant: 'Q4_K_M', context: 98_304 } } });
    expect(out).toContain('при контексте 96K');
    expect(out).toContain('замер снят при другом выборе');
  });

  it('файл из Ollama: настоящее квантование и пометка «перенесён из Ollama», голого «Ollama» нет', () => {
    const imported = {
      ...INSTALLED,
      quant: 'Ollama',
      quants: ['Ollama'],
      quantLabel: 'Q4_K_M',
      source: 'ollama',
      bench: { ...INSTALLED.bench, quant: 'Ollama' },
    };
    const out = html({ installed: [imported] as never, choices: {} });
    expect(out).toContain('Q4_K_M · перенесён из Ollama');
    expect(out).toContain('64K, Q4_K_M');
    // Служебная метка не выходит на экран ни подписью, ни значением в тексте.
    expect(out).not.toMatch(/Ollama[ ·]+d/);
    expect(out).not.toContain('64K, Ollama');
    // Файл на диске есть: «Замерить» доступно, «Скачать» нет.
    expect(out).toContain('Замерить');
    expect(out).not.toContain('Скачать');
  });

  it('файл из Ollama, квантование которого не определилось: «неизвестное квантование», не «Ollama»', () => {
    const imported = {
      ...INSTALLED,
      quant: 'Ollama',
      quants: ['Ollama'],
      source: 'ollama',
      bench: { ...INSTALLED.bench, quant: 'Ollama' },
    };
    const out = html({ installed: [imported] as never, choices: {} });
    expect(out).toContain('неизвестное квантование · перенесён из Ollama');
    expect(out).toContain('64K, неизвестное квантование');
    expect(out).not.toMatch(/>Ollama[ ·]|, Ollama\)/);
  });

  it('перезапуск сервера с новыми настройками виден в строке', () => {
    const job = {
      id: 'j1',
      kind: 'server',
      target: MODEL.tag,
      state: 'running',
      phase: 'restart',
      doneBytes: 0,
      totalBytes: 0,
      speed: 0,
      startedAt: '2026-10-14T00:00:00Z',
    };
    expect(html({ jobs: [job] as never })).toContain('Перезапуск с новыми настройками');
    expect(html()).not.toContain('Перезапуск с новыми настройками');
  });

  it('своя модель: «Своя» и «Агентность не проверена» до пробы; после неудачной — «Инструменты не вызывает»', () => {
    const custom = { ...MODEL, tag: 'hf:o/r', custom: true, toolsProbe: 'unknown' };
    const unknown = html({ catalog: { models: [custom] } as never, installed: [] });
    expect(unknown).toContain('Своя');
    expect(unknown).toContain('Агентность не проверена');
    const failed = html({
      catalog: { models: [{ ...custom, toolsProbe: 'failed', agentic: false }] } as never,
      installed: [],
    });
    expect(failed).toContain('Инструменты не вызывает');
    expect(failed).not.toContain('Агентность не проверена');
    const ok = html({
      catalog: { models: [{ ...custom, toolsProbe: 'ok' }] } as never,
      installed: [],
    });
    expect(ok).not.toContain('Агентность не проверена');
    // Корзина у своей записи есть и без скачанных файлов: запись убирается из списка.
    expect(unknown).toContain('aria-label="Удалить"');
  });
});
