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
 * контекстом 65536 (меньшее из `defaultContext` каталога и того, что влезло; запись
 * сервера несёт тот же контекст, иначе кадр показал бы сервер, который пришлось бы
 * перезапускать).
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { REPO_ROOT } from './kit.mjs';

const RAW_CATALOG = JSON.parse(
  readFileSync(join(REPO_ROOT, 'apps/server/src/domains/local-models/data/catalog.json'), 'utf8'),
);
// Сервер отдаёт каталог после разбора схемы контрактов: к модели добавлены размер
// выбранного по умолчанию квантования и байт кеша на токен. Заглушка повторяет
// эти два поля, иначе страница считала бы подбор из `undefined`.
const CATALOG = {
  ...RAW_CATALOG,
  models: RAW_CATALOG.models.map((model) => ({
    ...model,
    sizeBytes: (model.quants.find((quant) => quant.id === model.defaultQuant) ?? model.quants[0])
      .sizeBytes,
    kvBytesPerToken: model.arch.kvLayers * 2 * model.arch.kvHeads * model.arch.headDim * 2,
  })),
};

export const TAG = 'qwen3.6:27b-coding';
const MODEL = CATALOG.models.find((model) => model.tag === TAG);
const ROOT = 'D:\\agentdeck\\.local-models';
const RUNTIME = `${ROOT}\\runtime\\llama-b11583\\llama-server.exe`;
const NOW = '2026-10-05T16:20:00.000Z';
/** «Claude Code на этой модели» — выключено, как по умолчанию. */
const CLAUDE_OFF = {
  on: false,
  model: '',
  settingsPath: 'C:\\Users\\you\\.claude\\settings.json',
  vars: [],
  drift: [],
};

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
    latest: { version: 'b11583', sizeBytes: 640_000_000 },
  },
  server: {
    running: false,
    port: 11435,
    baseUrl: 'http://127.0.0.1:11435',
    loaded: [],
    context: 0,
    device: 'gpu',
  },
  catalog: CATALOG,
  installed: [],
  importable: [],
  importFailed: [],
  jobs: [],
  connect: { configured: false, active: false, model: '' },
  qwenCode: { binary: '', version: '', source: 'none' },
  kit: { claude: 'global', qwen: 'global', variant: 'local' },
  device: 'gpu',
  choices: {},
  claude: CLAUDE_OFF,
  diskUsedBytes: 0,
});

const runningServer = (loaded = [], context = 65536) => ({
  running: true,
  port: 11435,
  baseUrl: 'http://127.0.0.1:11435',
  pid: 18244,
  model: TAG,
  quant: 'Q4_K_M',
  mtp: true,
  loaded,
  context,
  device: 'gpu',
  kvCache: 'q8_0',
});
const panelRuntime = {
  source: 'panel',
  binary: RUNTIME,
  version: 'b11583',
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
      {
        tag: TAG,
        vramBytes: 21_300_000_000,
        sizeBytes: 21_300_000_000,
        until: '2026-10-05T16:40:00.000Z',
      },
    ]),
    installed: [
      {
        tag: TAG,
        quant: 'Q4_K_M',
        source: 'hf',
        sizeBytes: MODEL.sizeBytes,
        modifiedAt: NOW,
        known: true,
        bench: {
          tokensPerSec: 61.4,
          promptTokensPerSec: 2210,
          measuredAt: NOW,
          gpu: 'NVIDIA GeForce RTX 4090',
          // С чем снят замер: окно по умолчанию (65536) и скачанное квантование.
          context: 65536,
          quant: 'Q4_K_M',
          kvCache: 'q8_0',
          offload: 'all',
        },
        quants: ['Q4_K_M'],
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

/** Выбрано другое окно у загруженной модели: сервер перезапускается с новым `-c`. */
STATES.restarting = () => {
  const ready = STATES.ready();
  return {
    ...ready,
    choices: { [TAG]: { quant: 'Q4_K_M', context: 98304 } },
    jobs: [
      {
        id: 'job-restart',
        kind: 'server',
        target: TAG,
        state: 'running',
        phase: 'restart',
        doneBytes: 0,
        totalBytes: 0,
        speed: 0,
        startedAt: NOW,
      },
    ],
  };
};

/**
 * Скачаны два квантования: Q4_K_M держит сервер (корзины нет), UD-Q4_K_XL лежит без дела
 * (корзина с объёмом) — остров «На диске» и окно удаления.
 */
STATES.files = () => {
  const ready = STATES.ready();
  const own = ready.installed[0];
  const xl = MODEL.quants.find((quant) => quant.id === 'UD-Q4_K_XL').sizeBytes;
  const file = (quant, sizeBytes) => ({ quant, source: 'hf', sizeBytes, freesBytes: sizeBytes });
  return {
    ...ready,
    installed: [
      {
        ...own,
        quants: ['Q4_K_M', 'UD-Q4_K_XL'],
        files: [file('Q4_K_M', MODEL.sizeBytes), file('UD-Q4_K_XL', xl)],
      },
    ],
  };
};

/** Модель из «Любая модель»: репозиторий прочитан, агентность ещё не проверена. */
const CUSTOM = {
  ...MODEL,
  tag: 'hf:unsloth/Qwen3-14B-GGUF',
  title: 'Qwen3-14B',
  repo: 'unsloth/Qwen3-14B-GGUF',
  coding: 'general',
  quants: [
    { id: 'Q3_K_M', file: 'Qwen3-14B-Q3_K_M.gguf', sizeBytes: 7_320_000_000 },
    { id: 'Q4_K_M', file: 'Qwen3-14B-Q4_K_M.gguf', sizeBytes: 9_000_000_000 },
    { id: 'Q5_K_M', file: 'Qwen3-14B-Q5_K_M.gguf', sizeBytes: 10_500_000_000 },
    { id: 'Q6_K', file: 'Qwen3-14B-Q6_K.gguf', sizeBytes: 12_100_000_000 },
    { id: 'Q8_0', file: 'Qwen3-14B-Q8_0.gguf', sizeBytes: 15_700_000_000 },
  ],
  defaultQuant: 'Q4_K_M',
  sizeBytes: 9_000_000_000,
  paramsB: 14.8,
  activeParamsB: 14.8,
  mtp: false,
  contextMax: 40960,
  defaultContext: undefined,
  arch: { layers: 40, kvLayers: 40, kvHeads: 8, headDim: 128 },
  kvBytesPerToken: 40 * 2 * 8 * 128 * 2,
  custom: true,
  toolsProbe: 'unknown',
};

/**
 * Подменить `/api/local-models` текущим состоянием. Выбор квантования и окна и
 * «Любая модель» держат состояние внутри `holder`: списки в кадре пересчитываются
 * настоящей страницей от того, что выбрано, — так кадр показывает ответ на клик,
 * а не вымысел. Остальные действия отвечают успехом и ничего не меняют.
 */
export async function localModelsRoutes(page, holder) {
  holder.choices ??= {};
  holder.custom ??= [];
  await page.route('**/api/local-models**', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (request.method() === 'PUT' && url.pathname.endsWith('/choice')) {
      const { tag, ...body } = request.postDataJSON();
      holder.choices[tag] = { ...holder.choices[tag], ...body };
      return route.fulfill({ json: { choice: holder.choices[tag] } });
    }
    if (request.method() === 'POST' && url.pathname.endsWith('/custom')) {
      holder.custom = [CUSTOM];
      return route.fulfill({ json: CUSTOM });
    }
    if (request.method() === 'GET') {
      const state = holder.state();
      return route.fulfill({
        json: {
          ...state,
          catalog: { ...state.catalog, models: [...state.catalog.models, ...holder.custom] },
          choices: { ...state.choices, ...holder.choices },
        },
      });
    }
    return route.fulfill({ json: { ok: true } });
  });
}
