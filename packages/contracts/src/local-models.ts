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
  /**
   * Чужая видеопамять вытесняется по требованию (Windows, WDDM): занятое
   * программами рабочего стола — не жёсткий предел для модели.
   */
  pageable?: boolean;
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
/**
 * Сколько рабочий стол Windows удерживает на карте, когда модели нужна память.
 * Замер 08.10 (4090): Figma, Chrome, Docker и прочие держали 4,1 ГБ, подбор по
 * «свободно» давал 27B лишь 16K; сервер на 131072 с q4_0 встал на карту целиком
 * (120 ток/с), рабочий стол ужался до ~2,4 ГБ.
 */
export const PAGEABLE_DESKTOP_GB = 2.4;
/**
 * Служебное сверх весов и кеша, занятое на деле: контекст CUDA, буферы
 * вычислений, проектор картинок. Замер 07.10 (4090, qwen3.6:27b-coding, 98304):
 * карта занята на 21,1 ГиБ больше фона — на 1,4 больше весов и кеша.
 */
export const RUNTIME_OVERHEAD_GB = 1.4;
/**
 * Свободное, которое Ollama оставляет на карте сам: модель, которой без него
 * впритык, он молча делит с процессором. С подбором «впритык» при 22,3 ГиБ
 * свободных сервер поднялся с 131072, и Ollama положил на карту 15,1 из 17,6 ГиБ —
 * 4,4 ток/с вместо 107. Не занято, поэтому в зачёт памяти своего сервера не входит.
 */
export const OLLAMA_GPU_RESERVE_GB = 0.6;
/** Кеш ключей и значений в q8_0 (OLLAMA_KV_CACHE_TYPE) занимает ~0.53 от f16. */
export const KV_Q8_FACTOR = 0.53;
/**
 * Кеш в q4_0 — по замеру, а не по разрядности: 4,5 бита из 16 дали бы 0,28, но
 * 27B при 131072 заняла на карте 20,75 ГиБ сверх фона (07.10), то есть ~0,35; берётся
 * 0,36, чтобы оценка не оказалась ниже замера.
 */
export const KV_Q4_FACTOR = 0.36;
/** Тип кеша контекста на сервере: q8_0 почти без потерь, q4_0 — вдвое меньше и чуть хуже. */
export const kvCacheTypes = ['q8_0', 'q4_0'] as const;
export type KvCacheType = (typeof kvCacheTypes)[number];
const KV_FACTOR: Record<KvCacheType, number> = { q8_0: KV_Q8_FACTOR, q4_0: KV_Q4_FACTOR };
/**
 * Контекст, к которому стремится подбор (владелец 06.10: агенту на
 * qwen3.6:27b-coding — не меньше 128K). Кеш сжимается до q4_0, когда это даёт
 * контекст длиннее, чем q8_0; если q8_0 и так дотягивает — остаётся q8_0.
 */
export const TARGET_CONTEXT = 131_072;
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

/** `cpu` — модель целиком в оперативной памяти: выбран счёт на процессоре или карты нет. */
export type ModelFitLevel = 'gpu' | 'partial' | 'cpu' | 'none';

/**
 * Скорость, ниже которой агенту на процессоре не дождаться ответа, ток/с. Агент
 * пишет тысячи токенов на шаг: при 3 ток/с один шаг — четверть часа. Плотные
 * 27B на процессоре дают 2–4, смеси экспертов с 3B активных — десятки.
 */
export const CPU_AGENT_MIN_TPS = 8;

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
  reason?: 'too-big' | 'no-tools' | 'small-context' | 'partial' | 'cpu-slow';
  /** Тип кеша контекста, с которым сервер поднимется под эту модель; нет — q8_0. */
  kvCache?: KvCacheType;
}

const GB = 1024 ** 3;

/** Память под модель с контекстом `context`, ГБ. */
export function modelNeedGb(
  model: CatalogModel,
  context: number,
  kvCache: KvCacheType = 'q8_0',
): number {
  const weights = model.sizeBytes / GB;
  const kv = (model.kvBytesPerToken * context * KV_FACTOR[kvCache]) / GB;
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
  // Предсказание нескольких токенов ускоряет, когда модель целиком на одном
  // устройстве — и на процессоре тоже (замер 07.10, 7950X: 3,9–8,9 ток/с при
  // оценке без него 2–3). Разделённая между картой и процессором — без поправки.
  if (model.mtp && (share === 0 || share === 1)) rate *= MTP_SPEEDUP;
  return [round(rate * 0.75), round(rate * 1.15)];
}

/** Память, доступная модели на карте: свободная, если известна, иначе вся минус стол. */
export function usableVramGb(
  gpu: Pick<HardwareGpu, 'vramGb' | 'freeGb' | 'unified' | 'pageable'>,
): number {
  // Объединённой памятью Apple видеокарта владеет не целиком: macOS по умолчанию
  // отдаёт ей около трёх четвертей.
  if (gpu.unified) return gpu.vramGb * 0.72;
  if (gpu.freeGb !== undefined) {
    return gpu.pageable ? Math.max(gpu.freeGb, gpu.vramGb - PAGEABLE_DESKTOP_GB) : gpu.freeGb;
  }
  return Math.max(0, gpu.vramGb - DESKTOP_RESERVE_GB);
}

/**
 * Видеопамять карты с учётом нашего же сервера: модель, которую он держит
 * загруженной, освободится при его перезапуске, значит, для подбора она свободна.
 * Без этого загруженная 27B «съедала» свою же память: подбор видел 0,7 ГБ
 * свободных, писал «частично в оперативной памяти, 2–3 ток/с» при замере 98, а
 * сервер при подключении поднимался с урезанным контекстом.
 */
export function withOwnHeldVram(gpu: HardwareGpu, heldBytes: number): HardwareGpu {
  if (gpu.freeGb === undefined || gpu.unified || heldBytes <= 0) return gpu;
  const free = Math.min(gpu.vramGb, gpu.freeGb + heldBytes / GB);
  return { ...gpu, freeGb: Math.round(free * 10) / 10 };
}

/**
 * Сколько видеопамяти держит наш сервер, байт. `size_vram` Ollama меньше правды:
 * контекст CUDA и рабочие буферы исполнителя в него не входят (замер 07.10:
 * `size_vram` 16,4 ГиБ, карта занята на 21,1 ГиБ больше, чем без модели). Для
 * модели каталога целиком на карте берётся наша же оценка при контексте сервера
 * — та, по которой сервер и поднимался; разделённая с процессором — как есть.
 */
export function heldVramBytes(
  loaded: { tag: string; vramBytes: number; sizeBytes: number }[],
  catalog: CatalogModel[],
  context: number,
  kvCache: KvCacheType = 'q8_0',
): number {
  let held = 0;
  for (const item of loaded) {
    const model = catalog.find((entry) => entry.tag === item.tag);
    const whole = item.sizeBytes > 0 && item.vramBytes >= item.sizeBytes * 0.99;
    const estimate = model && whole && context > 0 ? modelNeedGb(model, context, kvCache) * GB : 0;
    held += Math.max(item.vramBytes, estimate);
  }
  return held;
}

/** Память, которую модель может занять в оперативной, оставив системе четверть. */
function ramForModelGb(ramGb: number): number {
  return Math.max(0, ramGb * 0.75 - 4);
}

/** Модель целиком в оперативной памяти: самый длинный контекст, который туда ляжет. */
function fitOnCpu(model: CatalogModel, ramGb: number): ModelFit {
  const ram = ramForModelGb(ramGb);
  const steps = CONTEXT_STEPS.filter((step) => step <= model.contextMax);
  const context = steps.find((step) => modelNeedGb(model, step) <= ram);
  if (context === undefined) {
    const smallest = Math.min(AGENT_MIN_CONTEXT, model.contextMax);
    const need = modelNeedGb(model, smallest);
    return {
      tag: model.tag,
      level: 'none',
      context: smallest,
      needGb: need,
      offloadGb: need,
      tokensPerSec: [0, 0],
      agentReady: false,
      reason: 'too-big',
    };
  }
  const need = modelNeedGb(model, context);
  const tokensPerSec = estimateTokensPerSec(model, { bandwidthGbs: RAM_BANDWIDTH_GBS }, need);
  const fast = tokensPerSec[0] >= CPU_AGENT_MIN_TPS;
  const agentReady = model.agentic && context >= AGENT_MIN_CONTEXT && fast;
  const reason = !model.agentic ? 'no-tools' : !fast ? 'cpu-slow' : 'small-context';
  return {
    tag: model.tag,
    level: 'cpu',
    context,
    needGb: need,
    offloadGb: need,
    tokensPerSec,
    agentReady,
    ...(agentReady ? {} : { reason }),
  };
}

/**
 * Как модель ляжет на эту карту и при этой оперативной памяти. Карты нет (или
 * выбран счёт на процессоре — `deviceGpu`) — модель целиком в оперативной.
 */
export function fitModel(
  model: CatalogModel,
  gpu: HardwareGpu | undefined,
  ramGb: number,
): ModelFit {
  if (!gpu) return fitOnCpu(model, ramGb);
  const vram = usableVramGb(gpu);
  const steps = CONTEXT_STEPS.filter((step) => step <= model.contextMax);
  const fits = (context: number, kvCache: KvCacheType): boolean =>
    modelNeedGb(model, context, kvCache) + OLLAMA_GPU_RESERVE_GB <= vram;
  const onGpuQ8 = steps.find((step) => fits(step, 'q8_0'));
  const onGpuQ4 = steps.find((step) => fits(step, 'q4_0'));
  const base = { tag: model.tag };
  if (onGpuQ4 !== undefined) {
    // q4_0 — всякий раз, когда он даёт контекст длиннее q8_0 (владелец 08.10: 16K
    // агенту мало, лучше чуть грубее кеш, чем обрезанный промпт).
    const lift = onGpuQ8 === undefined || onGpuQ4 > onGpuQ8;
    const context = lift ? onGpuQ4 : onGpuQ8;
    const kvCache: KvCacheType = lift ? 'q4_0' : 'q8_0';
    const agentReady = model.agentic && context >= AGENT_MIN_CONTEXT;
    return {
      ...base,
      level: 'gpu',
      context,
      kvCache,
      needGb: modelNeedGb(model, context, kvCache),
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
  const ramForModel = ramForModelGb(ramGb);
  const offload = Math.max(0, need + OLLAMA_GPU_RESERVE_GB - vram);
  if (offload <= ramForModel && offload < need) {
    return {
      ...base,
      level: 'partial',
      context,
      needGb: need,
      offloadGb: offload,
      tokensPerSec: estimateTokensPerSec(model, gpu, offload),
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

// ── Устройство счёта ──────────────────────────────────────────────────────

/**
 * Где считает модель. Умолчание — видеокарта (на Mac — Metal на объединённой
 * памяти); процессор — по выбору человека: карта занята другим, драйвер капризит
 * или модель в карту не влезает вовсе.
 */
export const localDevices = ['gpu', 'cpu'] as const;
export type LocalDevice = (typeof localDevices)[number];
export const localDeviceBodySchema = object({ device: zodEnum(localDevices) });

/** Карта, на которую считать подбор: при счёте на процессоре — никакая. */
export function deviceGpu(
  hardware: Pick<HardwareInfo, 'gpus'>,
  device: LocalDevice,
): HardwareGpu | undefined {
  return device === 'cpu' ? undefined : hardware.gpus[0];
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
  loaded: { tag: string; vramBytes: number; sizeBytes: number; until: string }[];
  /** Контекст, с которым поднят сервер. */
  context: number;
  /** Тип кеша контекста запущенного сервера; не поднят — нет. */
  kvCache?: KvCacheType;
  /** Устройство, с которым поднят сервер; не поднят — выбранное. */
  device: LocalDevice;
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
  /** Где считал сервер при замере; у замеров до 07.10 нет — то была видеокарта. */
  device?: LocalDevice;
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

/**
 * «Claude Code на локальной модели»: блок `env` в settings.json Claude, который
 * уводит САМ Claude Code (терминал, расширение редактора, чаты панели) на сервер
 * моделей. Выключено — прежние значения возвращены, как были.
 */
export interface LocalClaudeInfo {
  on: boolean;
  /** Модель, на которую уведён Claude; выключено — пусто. */
  model: string;
  /** Файл, куда пишется переключатель. */
  settingsPath: string;
  /** Переменные, которые переключатель ставит (и снимает). */
  vars: string[];
  /**
   * Записанное панелью кто-то сменил руками после включения: такие переменные
   * выключение не трогает, чтобы не стереть чужую правку.
   */
  drift: string[];
}
export const localClaudeBodySchema = object({
  on: boolean(),
  tag: string().min(1).max(200).optional(),
});

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
  /** Выбранное устройство счёта (умолчание — видеокарта). */
  device: LocalDevice;
  claude: LocalClaudeInfo;
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
