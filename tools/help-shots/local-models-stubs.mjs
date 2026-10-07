/**
 * Снимки раздела «Локальные модели» для съёмки справки.
 *
 * Форма — `LocalModelsInfo` из `packages/contracts/src/local-models.ts`, каталог —
 * настоящий `apps/server/src/domains/local-models/data/catalog.json`: подбор под
 * карту, оценку скорости и «Рекомендуем» страница считает сама, теми же функциями,
 * что и у человека. Подменено только то, что зависит от машины и от времени:
 * карта, сервер, загрузка, замер.
 *
 * Карта — RTX 4090 на 24 ГБ; рекомендуемая модель на ней — Qwen3.6 27B Coding с
 * контекстом 131072 (так её и считает `recommendModel`; запись сервера несёт тот же
 * контекст, иначе кадр показал бы сервер, который пришлось бы перезапускать).
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { REPO_ROOT } from './kit.mjs';

const CATALOG = JSON.parse(
  readFileSync(join(REPO_ROOT, 'apps/server/src/domains/local-models/data/catalog.json'), 'utf8'),
);

export const TAG = 'qwen3.6:27b-coding';
const MODEL = CATALOG.models.find((model) => model.tag === TAG);
const ROOT = 'D:\\agentdeck\\.local-models';
const RUNTIME = `${ROOT}\\runtime\\ollama-0.35.1\\ollama.exe`;
const NOW = '2026-10-05T16:20:00.000Z';

const base = () => ({
  root: ROOT,
  hardware: {
    gpus: [
      {
        vendor: 'nvidia',
        name: 'NVIDIA GeForce RTX 4090',
        vramGb: 24,
        freeGb: 21.8,
        bandwidthGbs: 1008,
        bandwidthFrom: 'table',
      },
    ],
    ramGb: 63.8,
    diskFreeGb: 412.5,
    platform: 'win32',
    arch: 'x64',
    detectedBy: 'nvidia-smi',
  },
  runtime: {
    source: 'none',
    binary: '',
    version: '',
    outdated: false,
    systemBinary: '',
    latest: { version: '0.35.1', sizeBytes: 1_870_000_000 },
  },
  server: {
    running: false,
    port: 11435,
    baseUrl: 'http://127.0.0.1:11435',
    loaded: [],
    context: 0,
  },
  catalog: CATALOG,
  installed: [],
  importable: [],
  jobs: [],
  connect: { configured: false, active: false, model: '' },
  qwenCode: { binary: '', version: '', source: 'none' },
  kit: { claude: 'global', qwen: 'global', variant: 'local' },
  diskUsedBytes: 0,
});

const runningServer = (loaded = []) => ({
  running: true,
  port: 11435,
  baseUrl: 'http://127.0.0.1:11435',
  pid: 18244,
  loaded,
  context: 131072,
});
const panelRuntime = {
  source: 'panel',
  binary: RUNTIME,
  version: '0.35.1',
  outdated: false,
  systemBinary: '',
};

/** Состояния по порядку пути человека. */
export const STATES = {
  /** Первый вход: карта прочитана, сервера нет, ничего не скачано. */
  empty: () => base(),

  /** Нажато «Скачать»: сервер поставлен и поднят, модель качается. */
  pulling: () => ({
    ...base(),
    runtime: panelRuntime,
    server: runningServer(),
    jobs: [
      {
        id: 'job-pull',
        kind: 'model',
        target: TAG,
        state: 'running',
        phase: 'pull',
        doneBytes: 7_640_000_000,
        totalBytes: MODEL.sizeBytes,
        speed: 52_400_000,
        startedAt: NOW,
      },
    ],
    diskUsedBytes: 9_510_000_000,
  }),

  /** Готово: модель скачана, замерена, в памяти и отдана агентам. */
  ready: () => ({
    ...base(),
    runtime: panelRuntime,
    server: runningServer([
      { tag: TAG, vramBytes: 21_300_000_000, until: '2026-10-05T16:40:00.000Z' },
    ]),
    installed: [
      {
        tag: TAG,
        sizeBytes: MODEL.sizeBytes,
        modifiedAt: NOW,
        known: true,
        bench: {
          tokensPerSec: 61.4,
          promptTokensPerSec: 2210,
          measuredAt: NOW,
          gpu: 'NVIDIA GeForce RTX 4090',
        },
      },
    ],
    connect: { configured: true, active: true, model: TAG },
    qwenCode: {
      binary: `${ROOT}\\tools\\qwen-code\\node_modules\\.bin\\qwen.cmd`,
      version: '0.25.0',
      source: 'panel',
    },
    kit: { claude: 'ours', qwen: 'global', variant: 'local' },
    diskUsedBytes: 19_640_000_000,
  }),
};

/**
 * Подменить `/api/local-models` текущим состоянием. Действия страницы отвечают
 * успехом и ничего не меняют — кадры переключает сценарий, а не клик.
 */
export async function localModelsRoutes(page, holder) {
  await page.route('**/api/local-models**', async (route) => {
    const request = route.request();
    if (request.method() === 'GET') return route.fulfill({ json: holder.state() });
    return route.fulfill({ json: { ok: true } });
  });
}
