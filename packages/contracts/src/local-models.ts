import { array, boolean, enum as zodEnum, number, object, string, type infer as Infer } from 'zod';

/**
 * Локальные модели: сервер моделей (Ollama), каталог моделей под код и подбор
 * под видеокарту.
 *
 * Здесь — схемы файлов данных (каталог и справочник видеокарт), ответ раздела и
 * ЧИСТАЯ арифметика подбора: влезает ли модель, какой контекст ставить и сколько
 * токенов в секунду ждать. Арифметика живёт в контрактах, а не на сервере, потому
 * что её проверяют тесты обеих сторон, а экран пересчитывает её для карты,
 * выбранной вручную, — без похода на сервер за каждым щелчком.
 */

export const gpuVendors = ['nvidia', 'amd', 'apple', 'intel', 'cpu'] as const;
export type GpuVendor = (typeof gpuVendors)[number];

/** Строка справочника видеокарт: память и пропускная способность. */
export const gpuSpecSchema = object({
  /** Название как в выдаче драйвера, без производителя: «RTX 4090», «RX 7900 XTX», «M3 Max». */
  name: string().min(1),
  vendor: zodEnum(gpuVendors),
  /** Память видеокарты, ГБ. У Apple — объём объединённой памяти самой младшей сборки. */
  vramGb: number().positive(),
  /** Пропускная способность памяти, ГБ/с — ею и ограничена скорость генерации. */
  bandwidthGbs: number().positive(),
});
export type GpuSpec = Infer<typeof gpuSpecSchema>;

export const gpuTableSchema = object({ version: string(), gpus: array(gpuSpecSchema) });
export type GpuTable = Infer<typeof gpuTableSchema>;

/**
 * Насколько модель про код. Различие не косметическое: специализированная
 * обучена на агентских задачах с проверяемым результатом, общая — сильна, но
 * не заточена; человек выбирает по этой строке, а не по названию.
 */
export const modelCodingKinds = ['specialized', 'tuned', 'general'] as const;
export type ModelCodingKind = (typeof modelCodingKinds)[number];

/** Модель каталога — один тег Ollama. */
export const catalogModelSchema = object({
  /** Тег Ollama целиком: `qwen3.6:27b-coding`. Им модель и скачивается. */
  tag: string().min(1),
  /** Имя для людей: «Qwen3.6 27B Coding». */
  title: string().min(1),
  family: string().min(1),
  coding: zodEnum(modelCodingKinds),
  /** Размер скачивания, байт — сумма слоёв манифеста реестра. */
  sizeBytes: number().int().positive(),
  /** Всего параметров, млрд. */
  paramsB: number().positive(),
  /** Активных на токен, млрд (у плотной модели равно `paramsB`). */
  activeParamsB: number().positive(),
  /** Байт кеша ключей и значений на токен контекста при f16 — им растёт память с контекстом. */
  kvBytesPerToken: number().int().positive(),
  /** Предел контекста модели, токенов. */
  contextMax: number().int().positive(),
  /** Встроено ли ускорение предсказанием нескольких токенов (теги `-coding`/`-mtp`). */
  mtp: boolean().default(false),
  /**
   * Зовёт ли модель инструменты по полю `tools`. Ложь — модель поле принимает,
   * но не зовёт (Qwen 2.5 Coder за Ollama): агентом она не работает, и каталог
   * говорит это словами, а не прячет её.
   */
  agentic: boolean(),
  /** Наименьшая версия Ollama, знающая модель. */
  ollamaMin: string().default('0.14.0'),
  /** Дата выпуска модели, ГГГГ-ММ. */
  released: string().default(''),
  /** Где сверены размер и параметры — для того, кто будет обновлять каталог. */
  source: string().default(''),
});
export type CatalogModel = Infer<typeof catalogModelSchema>;

export const modelCatalogSchema = object({
  version: string(),
  /** Когда каталог сверен с реестром. Устаревший каталог виден по этой дате. */
  checkedAt: string(),
  models: array(catalogModelSchema),
});
export type ModelCatalog = Infer<typeof modelCatalogSchema>;

/** Что панель узнала о железе. */
export interface HardwareGpu {
  vendor: GpuVendor;
  /** Название, как отдал драйвер. */
  name: string;
  vramGb: number;
  /** Свободно сейчас, если драйвер это говорит (NVIDIA, AMD на Linux). */
  freeGb?: number;
  bandwidthGbs: number;
  /** Пропускная способность взята из справочника (`table`) или прикинута (`guess`). */
  bandwidthFrom: 'table' | 'guess';
  /** Объединённая память Apple: видеокарта делит её с системой. */
  unified?: boolean;
}

export interface HardwareInfo {
  /** Пусто — видеокарта не найдена, и раздел предлагает выбрать её руками. */
  gpus: HardwareGpu[];
  ramGb: number;
  /** Свободно на диске под каталогом моделей, ГБ. */
  diskFreeGb?: number;
  platform: string;
  arch: string;
  /** Как определили: какой командой — для строки «как мы это узнали». */
  detectedBy: string;
}

/** Сколько памяти держит рабочий стол сверх модели — когда драйвер свободное не сказал. */
export const DESKTOP_RESERVE_GB = 1;
/** Служебное сверх весов и кеша: буферы вычислений, проектор картинок. */
export const RUNTIME_OVERHEAD_GB = 0.9;
/** Кеш ключей и значений в q8_0 (OLLAMA_KV_CACHE_TYPE) занимает ~0.53 от f16. */
export const KV_Q8_FACTOR = 0.53;
/**
 * Наименьший контекст, с которым модель годится агенту: системный промпт Claude
 * Code с описанием инструментов сам занимает около 20 тысяч токенов.
 */
export const AGENT_MIN_CONTEXT = 32_768;
export const CONTEXT_STEPS = [131_072, 98_304, 65_536, 49_152, 32_768, 16_384, 8_192] as const;
/** Пропускная способность обычной двухканальной DDR5 на деле, ГБ/с. */
export const RAM_BANDWIDTH_GBS = 60;
/** Доля пиковой пропускной способности, которую генерация реально выбирает. */
export const DENSE_EFFICIENCY = 0.7;
export const MOE_EFFICIENCY = 0.35;
export const MTP_SPEEDUP = 1.6;

export type ModelFitLevel = 'gpu' | 'partial' | 'none';

export interface ModelFit {
  tag: string;
  level: ModelFitLevel;
  /** Контекст, который панель поставит этой модели на этой карте. */
  context: number;
  /** Нужно памяти при этом контексте, ГБ. */
  needGb: number;
  /** Сколько из модели уйдёт в оперативную память (для `partial`). */
  offloadGb: number;
  /** Оценка скорости генерации, токенов/с: [нижняя, верхняя]. */
  tokensPerSec: [number, number];
  /** Годится ли агенту: зовёт инструменты и влезает с контекстом ≥ AGENT_MIN_CONTEXT. */
  agentReady: boolean;
  /** Почему не годится — код причины для словаря экрана. */
  reason?: 'too-big' | 'no-tools' | 'small-context' | 'partial';
}

const GB = 1024 ** 3;

/** Память под модель с контекстом `context`, ГБ. */
export function modelNeedGb(model: CatalogModel, context: number): number {
  const weights = model.sizeBytes / GB;
  const kv = (model.kvBytesPerToken * context * KV_Q8_FACTOR) / GB;
  return weights + kv + RUNTIME_OVERHEAD_GB;
}

/** Байт, читаемых на один сгенерированный токен. */
function bytesPerTokenGb(model: CatalogModel): number {
  return (model.sizeBytes / GB) * (model.activeParamsB / model.paramsB);
}

function round(value: number): number {
  return value >= 20 ? Math.round(value / 5) * 5 : Math.max(1, Math.round(value));
}

/**
 * Оценка токенов в секунду. Генерация упирается в чтение весов из памяти:
 * пропускная способность, делённая на байты на токен, с поправкой на то, что
 * выбирается на деле. У смеси экспертов поправка меньше — эксперты читаются
 * вразброс. Часть модели в оперативной памяти читается с её скоростью, и
 * именно она тогда задаёт темп.
 */
export function estimateTokensPerSec(
  model: CatalogModel,
  gpu: Pick<HardwareGpu, 'bandwidthGbs'>,
  offloadGb = 0,
): [number, number] {
  const perToken = bytesPerTokenGb(model);
  const weights = model.sizeBytes / GB;
  const moe = model.activeParamsB < model.paramsB * 0.5;
  const efficiency = moe ? MOE_EFFICIENCY : DENSE_EFFICIENCY;
  const share = weights > 0 ? Math.min(1, offloadGb / weights) : 0;
  const gpuSeconds = (perToken * (1 - share)) / (gpu.bandwidthGbs * efficiency);
  const cpuSeconds = (perToken * share) / (RAM_BANDWIDTH_GBS * efficiency);
  let rate = 1 / (gpuSeconds + cpuSeconds);
  if (model.mtp && share === 0) rate *= MTP_SPEEDUP;
  return [round(rate * 0.75), round(rate * 1.15)];
}

/** Память, доступная модели на карте: свободная, если известна, иначе вся минус стол. */
export function usableVramGb(gpu: Pick<HardwareGpu, 'vramGb' | 'freeGb' | 'unified'>): number {
  // Объединённой памятью Apple видеокарта владеет не целиком: macOS по умолчанию
  // отдаёт ей около трёх четвертей.
  if (gpu.unified) return gpu.vramGb * 0.72;
  if (gpu.freeGb !== undefined) return gpu.freeGb;
  return Math.max(0, gpu.vramGb - DESKTOP_RESERVE_GB);
}

/** Как модель ляжет на эту карту и при этой оперативной памяти. */
export function fitModel(
  model: CatalogModel,
  gpu: HardwareGpu | undefined,
  ramGb: number,
): ModelFit {
  const vram = gpu ? usableVramGb(gpu) : 0;
  const steps = CONTEXT_STEPS.filter((step) => step <= model.contextMax);
  const onGpu = steps.find((step) => modelNeedGb(model, step) <= vram);
  const base = { tag: model.tag };
  if (onGpu !== undefined && gpu) {
    const agentReady = model.agentic && onGpu >= AGENT_MIN_CONTEXT;
    return {
      ...base,
      level: 'gpu',
      context: onGpu,
      needGb: modelNeedGb(model, onGpu),
      offloadGb: 0,
      tokensPerSec: estimateTokensPerSec(model, gpu),
      agentReady,
      ...(agentReady ? {} : { reason: model.agentic ? 'small-context' : 'no-tools' }),
    };
  }
  // Не влезла в карту: часть слоёв уйдёт в оперативную память. Оставляем системе
  // четверть памяти — иначе машина начнёт свопить и встанет вся.
  const context = Math.min(AGENT_MIN_CONTEXT, model.contextMax);
  const need = modelNeedGb(model, context);
  const ramForModel = Math.max(0, ramGb * 0.75 - 4);
  const offload = Math.max(0, need - vram);
  if (offload <= ramForModel && offload < need) {
    return {
      ...base,
      level: 'partial',
      context,
      needGb: need,
      offloadGb: offload,
      tokensPerSec: estimateTokensPerSec(
        model,
        gpu ?? { bandwidthGbs: RAM_BANDWIDTH_GBS },
        offload,
      ),
      agentReady: false,
      reason: model.agentic ? 'partial' : 'no-tools',
    };
  }
  return {
    ...base,
    level: 'none',
    context,
    needGb: need,
    offloadGb: offload,
    tokensPerSec: [0, 0],
    agentReady: false,
    reason: 'too-big',
  };
}

/**
 * Рекомендация для агента: самая сильная из годных агенту. «Сильнее» — по
 * порядку каталога (он упорядочен от лучшей к слабой для кода), а не по
 * размеру: 27B плотная пишет код лучше 35B со смесью экспертов.
 */
export function recommendModel(
  catalog: CatalogModel[],
  gpu: HardwareGpu | undefined,
  ramGb: number,
): { model: CatalogModel; fit: ModelFit } | undefined {
  for (const model of catalog) {
    const fit = fitModel(model, gpu, ramGb);
    if (fit.agentReady) return { model, fit };
  }
  return undefined;
}

// ── Ответ раздела ─────────────────────────────────────────────────────────

/** Наименьшая версия Ollama, которую панель поднимает без предупреждения: её знает весь каталог. */
export const MIN_OLLAMA_VERSION = '0.32.12';

export const runtimeSources = ['system', 'panel', 'none'] as const;
export type RuntimeSource = (typeof runtimeSources)[number];

export interface LocalRuntimeInfo {
  /** Чьим исполняемым файлом поднимается сервер панели. */
  source: RuntimeSource;
  /** Путь к исполняемому файлу; пусто — не найден. */
  binary: string;
  /** Версия, как ответил сервер; пусто — сервер ещё ни разу не поднимался. */
  version: string;
  /** Есть ли у версии всё, что нужно каталогу. */
  outdated: boolean;
  /** Найденная в системе установка — даже когда панель взяла свою. */
  systemBinary: string;
  /** Последняя версия для скачивания (если известна) и её размер. */
  latest?: { version: string; sizeBytes: number };
}

export interface LocalServerInfo {
  running: boolean;
  port: number;
  baseUrl: string;
  pid?: number;
  /** Модели, загруженные в память сейчас (`/api/ps`). */
  loaded: { tag: string; vramBytes: number; until: string }[];
  /** Контекст, с которым поднят сервер. */
  context: number;
  error?: string;
}

export interface InstalledModel {
  tag: string;
  sizeBytes: number;
  modifiedAt: string;
  /** Есть ли модель в каталоге панели. */
  known: boolean;
  /** Последний замер на этой машине. */
  bench?: ModelBench;
}

export interface ModelBench {
  tokensPerSec: number;
  promptTokensPerSec: number;
  measuredAt: string;
  gpu: string;
}

export const localJobKinds = ['runtime', 'model', 'qwen-code'] as const;
export type LocalJobKind = (typeof localJobKinds)[number];
export type LocalJobState = 'running' | 'done' | 'failed' | 'cancelled';

/**
 * Долгая работа с прогрессом: загрузка сервера, модели, Qwen Code. Живёт на
 * сервере, а не на странице: закрытая вкладка загрузку не обрывает, а новая
 * видит ту же полосу.
 */
export interface LocalJob {
  id: string;
  kind: LocalJobKind;
  /** Что качаем: тег модели, версия сервера. */
  target: string;
  state: LocalJobState;
  /** Этап словами (код для словаря): download, verify, extract, pull, install… */
  phase: string;
  doneBytes: number;
  totalBytes: number;
  /** Скорость, байт/с, по последним секундам. */
  speed: number;
  startedAt: string;
  finishedAt?: string;
  error?: string;
  /** Код текста ошибки — английский интерфейс переводит его своим словарём. */
  errorCode?: string;
  errorParams?: Record<string, string | number>;
}

export const kitModes = ['global', 'ours', 'hybrid'] as const;
/**
 * Чей набор навыков, хуков и правил получает агент:
 * `global` — только пользовательский (`~/.claude` и аналоги), по умолчанию;
 * `ours` — только набор панели; `hybrid` — оба.
 */
export type KitMode = (typeof kitModes)[number];
export const kitModeSchema = zodEnum(kitModes);

export interface LocalConnectInfo {
  /** Контур локальной модели заведён. */
  configured: boolean;
  /** И сейчас активен — чаты Claude идут в локальную модель. */
  active: boolean;
  /** Модель, на которую смотрит контур. */
  model: string;
  /** Активный контур, который включение локальной модели сменило бы. */
  otherActive?: string;
}

export interface QwenCodeInfo {
  /** Путь к `qwen`; пусто — не стоит. */
  binary: string;
  version: string;
  /** Поставлен панелью (в `.local-models/tools`) или найден в системе. */
  source: 'panel' | 'system' | 'none';
}

export interface LocalModelsInfo {
  root: string;
  hardware: HardwareInfo;
  runtime: LocalRuntimeInfo;
  server: LocalServerInfo;
  catalog: ModelCatalog;
  installed: InstalledModel[];
  /** Модели системного Ollama, которые можно забрать в панель без скачивания. */
  importable: { tag: string; sizeBytes: number }[];
  jobs: LocalJob[];
  connect: LocalConnectInfo;
  qwenCode: QwenCodeInfo;
  kit: { claude: KitMode; qwen: KitMode; variant: 'standard' | 'local' };
  /** Сколько занимает весь каталог `.local-models`, байт. */
  diskUsedBytes: number;
}

export const localPullBodySchema = object({ tag: string().min(1).max(200) });
export const localKitBodySchema = object({
  provider: zodEnum(['claude', 'qwen']),
  mode: kitModeSchema,
});
export const localConnectBodySchema = object({ tag: string().min(1).max(200) });
