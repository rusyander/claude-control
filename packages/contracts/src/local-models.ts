import {
  array,
  boolean,
  enum as zodEnum,
  number,
  object,
  record,
  string,
  union,
  type infer as Infer,
} from 'zod';

/**
 * Локальные модели: сервер моделей (llama.cpp), каталог моделей под код и подбор
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

/**
 * Квантование модели: один GGUF-файл репозитория Hugging Face. Список берётся из
 * дерева репозитория (`/api/models/<repo>/tree/main`), а не пишется по памяти;
 * в каталоге лежит снимок на дату `checkedAt` — для экрана без сети.
 */
export const modelQuantSchema = object({
  /** Метка квантования: `Q4_K_M`, `UD-Q4_K_XL`, `IQ4_NL`, `Q8_0`. */
  id: string().min(1),
  /** Имя файла в корне репозитория. */
  file: string().min(1),
  sizeBytes: number().int().positive(),
  /**
   * Настоящее квантование файла, когда `id` — служебная метка (слой, забранный из
   * Ollama): прочитано из заголовка GGUF (`general.file_type`), например `Q4_K_M`.
   */
  label: string().min(1).optional(),
  /** Откуда файл, если не Hugging Face: слой из хранилища Ollama, которым владеет llama.cpp. */
  source: zodEnum(['ollama']).optional(),
});
export type ModelQuant = Infer<typeof modelQuantSchema>;

/**
 * Что нужно знать об устройстве модели, чтобы посчитать кеш контекста: слои
 * полного внимания (у гибридных — каждый `fullAttentionInterval`-й), число
 * KV-голов и длина головы. Значения прочитаны из заголовка GGUF (`block_count`,
 * `attention.head_count_kv`, `attention.key_length`, `full_attention_interval`),
 * а не из карточки модели.
 */
export const modelArchSchema = object({
  /** Слоёв всего (у модели с MTP — включая слой предсказания). */
  layers: number().int().positive(),
  /** Слоёв, у которых есть кеш ключей и значений. */
  kvLayers: number().int().positive(),
  kvHeads: number().int().positive(),
  headDim: number().int().positive(),
});
export type ModelArch = Infer<typeof modelArchSchema>;

/** Байт кеша ключей и значений на токен контекста при f16: K и V, каждый по 2 байта. */
export function kvBytesPerTokenOf(arch: ModelArch): number {
  return arch.kvLayers * 2 * arch.kvHeads * arch.headDim * 2;
}

/** Модель каталога — репозиторий GGUF на Hugging Face и выбранное по умолчанию квантование. */
export const catalogModelSchema = object({
  /**
   * Стабильный идентификатор модели: по нему её знают контур, переключатель Claude,
   * замеры и сохранённый выбор. Остался от времён Ollama (`qwen3.6:27b-coding`) и
   * на самом деле не тег чьего-либо реестра — только имя.
   */
  tag: string().min(1),
  /** Имя для людей: «Qwen3.6 27B Coding». */
  title: string().min(1),
  family: string().min(1),
  coding: zodEnum(modelCodingKinds),
  /** Репозиторий Hugging Face с GGUF: `unsloth/Qwen3.6-27B-MTP-GGUF`. */
  repo: string().min(3),
  /** Квантования репозитория — снимок дерева на `checkedAt`. */
  quants: array(modelQuantSchema).min(1),
  /** Какое квантование качается, пока человек не выбрал своё. */
  defaultQuant: string().min(1),
  /** Всего параметров, млрд. */
  paramsB: number().positive(),
  /** Активных на токен, млрд (у плотной модели равно `paramsB`). */
  activeParamsB: number().positive(),
  arch: modelArchSchema,
  /** Предел контекста модели, токенов. */
  contextMax: number().int().positive(),
  /**
   * Контекст, с которым панель поднимает модель, пока человек не выбрал свой.
   * Выше него подбор не идёт, даже если карта вытянула бы больше. Нет поля —
   * берётся наибольший шаг, который лёг на карту. Итог — меньшее из «по умолчанию»
   * и «влезло» (влезло — целиком на карту: замер 15.10, 4090, 27B UD-Q4_K_XL, 128K
   * с кешем q4_0 вылез на 1,1 ГБ в общую память, и разбор промпта упал с 1900 до
   * 90 ток/с).
   *
   * У плотных 27B — 128K (L6, 15.10): полный набор Claude Code (MCP, все
   * инструменты, скиллы) — около 43 тыс. токенов основы, и в 64K сжатие шло на
   * каждом ходу. Карта, где 128K не лезет, получает наибольший влезающий шаг, а
   * рекомендация — квантование помельче на 128K.
   */
  defaultContext: number().int().positive().optional(),
  /**
   * В файле есть слой предсказания нескольких токенов (`nextn_predict_layers` > 0):
   * сервер поднимается с `--spec-type draft-mtp`, и генерация идёт вдвое быстрее
   * (замер 13.10, 4090, 27B: 47 → 82 ток/с) ценой ~1,2 ГБ видеопамяти.
   */
  mtp: boolean().default(false),
  /**
   * Зовёт ли модель инструменты по полю `tools`. Ложь — модель поле принимает,
   * но не зовёт (Qwen 2.5 Coder): агентом она не работает, и каталог говорит это
   * словами, а не прячет её.
   */
  agentic: boolean(),
  /**
   * Модель добавлена человеком по имени репозитория («Любая модель»), а не из
   * каталога панели: размеры и устройство прочитаны из репозитория и заголовка
   * GGUF при добавлении, убрать её можно из списка.
   */
  custom: boolean().default(false),
  /**
   * Проба инструментов (при подключении модели агентам): зовёт ли модель
   * инструмент полем `tools`. `unknown` — ещё не проверялась, модель считается
   * агентом «с оговоркой»; у моделей каталога поля нет — они сверены.
   */
  toolsProbe: zodEnum(['ok', 'failed', 'unknown']).optional(),
  /**
   * Параметры шаблона чата по умолчанию для всего сервера (`--chat-template-kwargs`):
   * у Qwen3.8 рассуждение по умолчанию `xhigh` — десятки тысяч токенов на ход, поэтому
   * каталог ставит `reasoning_effort: medium`. Запрос со своими параметрами их перекрывает.
   */
  chatTemplateKwargs: record(string(), union([string(), number(), boolean()])).optional(),
  /**
   * Свой шаблон чата вместо зашитого в GGUF (`--chat-template-file`), имя файла в
   * `data/templates/` сервера. У Qwen3.8 зашитый падает на системном сообщении не в
   * начале, а Claude Code такое шлёт в каждом запросе — без замены сервер отвечает 500.
   */
  chatTemplate: string()
    .regex(/^[\w.-]+\.jinja$/)
    .optional(),
  /** Дата выпуска модели, ГГГГ-ММ. */
  released: string().default(''),
  /** Где сверены репозиторий, файлы и устройство — для того, кто будет обновлять каталог. */
  source: string().default(''),
}).transform((model) => {
  const chosen = model.quants.find((quant) => quant.id === model.defaultQuant) ?? model.quants[0];
  return {
    ...model,
    /** Размер скачивания выбранного по умолчанию квантования, байт. */
    sizeBytes: chosen?.sizeBytes ?? 0,
    /** Байт кеша на токен при f16 — им растёт память с контекстом. */
    kvBytesPerToken: kvBytesPerTokenOf(model.arch),
  };
});
export type CatalogModel = Infer<typeof catalogModelSchema>;

export const modelCatalogSchema = object({
  version: string(),
  /** Когда каталог сверен с Hugging Face. Устаревший каталог виден по этой дате. */
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
 * Свободное, которое подбор оставляет на карте: рабочий стол занимает её память
 * по требованию, а модель, которой впритык, делит слои с процессором и теряет
 * в скорости на порядок (замер 08.10 на прежнем сервере: 4,4 ток/с вместо 107).
 * Не занято, поэтому в зачёт памяти своего сервера не входит.
 */
export const GPU_RESERVE_GB = 0.6;
/**
 * Видеопамять под слой предсказания нескольких токенов (MTP): замер 13.10, 4090,
 * Qwen3.6 27B Q4_K_M при 65536 и кеше q8_0 — 22,6 ГиБ против 21,4 без него.
 */
export const MTP_OVERHEAD_GB = 1.2;
/** Кеш ключей и значений в q8_0 (`-ctk q8_0 -ctv q8_0`) занимает ~0.53 от f16. */
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

/** Размер скачивания квантования; нет такого (или не названо) — квантование по умолчанию. */
export function quantSizeOf(model: CatalogModel, quantId?: string): number {
  return model.quants.find((quant) => quant.id === quantId)?.sizeBytes ?? model.sizeBytes;
}

/** Память под модель с контекстом `context` и выбранным квантованием, ГБ. */
/** Модель с размером выбранного квантования вместо размера по умолчанию — для арифметики подбора. */
export function withQuant(model: CatalogModel, quantId?: string): CatalogModel {
  return quantId ? { ...model, sizeBytes: quantSizeOf(model, quantId) } : model;
}

export function modelNeedGb(
  model: CatalogModel,
  context: number,
  kvCache: KvCacheType = 'q8_0',
  quantId?: string,
): number {
  const weights = quantSizeOf(model, quantId) / GB;
  const kv = (model.kvBytesPerToken * context * KV_FACTOR[kvCache]) / GB;
  return weights + kv + RUNTIME_OVERHEAD_GB + (model.mtp ? MTP_OVERHEAD_GB : 0);
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
 * Сколько видеопамяти держит наш сервер, байт. `size_vram` прежнего сервера был меньше правды:
 * контекст CUDA и рабочие буферы исполнителя в него не входят (замер 07.10:
 * `size_vram` 16,4 ГиБ, карта занята на 21,1 ГиБ больше, чем без модели). Для
 * модели каталога целиком на карте берётся наша же оценка при контексте сервера
 * — та, по которой сервер и поднимался; разделённая с процессором — как есть.
 */
export function heldVramBytes(
  loaded: { tag: string; vramBytes: number; sizeBytes: number; quant?: string }[],
  catalog: CatalogModel[],
  context: number,
  kvCache: KvCacheType = 'q8_0',
): number {
  let held = 0;
  for (const item of loaded) {
    const model = catalog.find((entry) => entry.tag === item.tag);
    const whole = item.sizeBytes > 0 && item.vramBytes >= item.sizeBytes * 0.99;
    const estimate =
      model && whole && context > 0 ? modelNeedGb(model, context, kvCache, item.quant) * GB : 0;
    held += Math.max(item.vramBytes, estimate);
  }
  return held;
}

/** Память, которую модель может занять в оперативной, оставив системе четверть. */
function ramForModelGb(ramGb: number): number {
  return Math.max(0, ramGb * 0.75 - 4);
}

/** Шаги контекста, доступные модели: до её предела и до выбранного для неё умолчания. */
function contextStepsOf(model: CatalogModel): number[] {
  const ceiling = Math.min(model.contextMax, model.defaultContext ?? Infinity);
  return CONTEXT_STEPS.filter((step) => step <= ceiling);
}

/** Модель целиком в оперативной памяти: самый длинный контекст, который туда ляжет. */
function fitOnCpu(model: CatalogModel, ramGb: number): ModelFit {
  const ram = ramForModelGb(ramGb);
  const steps = contextStepsOf(model);
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
  source: CatalogModel,
  gpu: HardwareGpu | undefined,
  ramGb: number,
  quantId?: string,
): ModelFit {
  const model = withQuant(source, quantId);
  if (!gpu) return fitOnCpu(model, ramGb);
  const vram = usableVramGb(gpu);
  const steps = contextStepsOf(model);
  const fits = (context: number, kvCache: KvCacheType): boolean =>
    modelNeedGb(model, context, kvCache) + GPU_RESERVE_GB <= vram;
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
  const offload = Math.max(0, need + GPU_RESERVE_GB - vram);
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

// ── Выбор квантования и окна ──────────────────────────────────────────────

/**
 * Модель с квантованием установленного файла, которого нет в списке репозитория
 * (слой, забранный из Ollama): память под него считается по размеру настоящего
 * файла, а не по размеру умолчания.
 */
export function withInstalledQuant(
  model: CatalogModel,
  installed:
    | { quant?: string; sizeBytes: number; quantLabel?: string; source?: 'hf' | 'ollama' }
    | undefined,
): CatalogModel {
  const id = installed?.quant;
  if (!installed || !id || model.quants.some((quant) => quant.id === id)) return model;
  return {
    ...model,
    quants: [
      ...model.quants,
      {
        id,
        file: '',
        sizeBytes: installed.sizeBytes,
        ...(installed.quantLabel ? { label: installed.quantLabel } : {}),
        ...(installed.source === 'ollama' ? { source: 'ollama' as const } : {}),
      },
    ],
  };
}

/** Как квантование называется для человека: настоящее из заголовка файла, не служебная метка. */
export function quantName(model: CatalogModel, id: string): string {
  return model.quants.find((quant) => quant.id === id)?.label ?? id;
}

/** Что человек выбрал для модели; не названное подбирается под карту. */
export interface ModelChoiceInfo {
  quant?: string;
  context?: number;
  kvCache?: KvCacheType;
  /** Разрешено делить модель между картой и оперативной памятью (медленнее). */
  allowPartial?: boolean;
}

/**
 * Шаги окна для выбора: от 8K до предела модели. Подбор по умолчанию идёт по
 * `CONTEXT_STEPS` (не выше 128K), а выбор человека — до настоящего предела.
 */
export const SELECT_CONTEXT_STEPS = [
  8_192, 16_384, 32_768, 49_152, 65_536, 98_304, 131_072, 196_608, 262_144, 393_216, 524_288,
  1_048_576,
] as const;

export function contextStepsFor(model: Pick<CatalogModel, 'contextMax'>): number[] {
  return [...SELECT_CONTEXT_STEPS.filter((step) => step < model.contextMax), model.contextMax];
}

/** Как лягут выбранные квантование и окно на эту машину; тип кеша подбирается сам. */
export interface ChoiceFit {
  level: ModelFitLevel;
  kvCache: KvCacheType;
  /** Нужно памяти, ГБ: веса выбранного файла + кеш окна + служебное. */
  needGb: number;
  /** Сколько есть: свободная видеопамять сейчас (или память под модель в оперативной). */
  availableGb: number;
  offloadGb: number;
  tokensPerSec: [number, number];
  /** Модель целиком на одном устройстве (карта или оперативная память). */
  fits: boolean;
  /** Можно выбрать: целиком, либо частично, если человек это разрешил. */
  allowed: boolean;
  agentReady: boolean;
  reason?: ModelFit['reason'];
}

/**
 * Подбор не по лучшему, а по названному: влезают ли ЭТО квантование и ЭТО окно.
 * Тип кеша — q8_0, а q4_0 лишь тогда, когда q8_0 не влезает. Память — свободная
 * сейчас (`usableVramGb`): карту делят с другими программами.
 */
export function fitChoice(
  source: CatalogModel,
  gpu: HardwareGpu | undefined,
  ramGb: number,
  pick: { quant: string; context: number },
  allowPartial = false,
): ChoiceFit {
  const model = withQuant(source, pick.quant);
  const { context } = pick;
  if (!gpu) {
    const ram = ramForModelGb(ramGb);
    const need = modelNeedGb(model, context);
    const fits = need <= ram;
    const tokensPerSec = fits
      ? estimateTokensPerSec(model, { bandwidthGbs: RAM_BANDWIDTH_GBS }, need)
      : ([0, 0] as [number, number]);
    const fast = tokensPerSec[0] >= CPU_AGENT_MIN_TPS;
    const agentReady = fits && model.agentic && context >= AGENT_MIN_CONTEXT && fast;
    const reason = !model.agentic
      ? 'no-tools'
      : !fits
        ? 'too-big'
        : !fast
          ? 'cpu-slow'
          : 'small-context';
    return {
      level: fits ? 'cpu' : 'none',
      kvCache: 'q8_0',
      needGb: need,
      availableGb: ram,
      offloadGb: need,
      tokensPerSec,
      fits,
      allowed: fits,
      agentReady,
      ...(agentReady ? {} : { reason }),
    };
  }
  const vram = usableVramGb(gpu);
  const need8 = modelNeedGb(model, context, 'q8_0');
  const need4 = modelNeedGb(model, context, 'q4_0');
  const kvCache: KvCacheType = need8 + GPU_RESERVE_GB <= vram ? 'q8_0' : 'q4_0';
  const need = kvCache === 'q8_0' ? need8 : need4;
  if (need + GPU_RESERVE_GB <= vram) {
    const agentReady = model.agentic && context >= AGENT_MIN_CONTEXT;
    return {
      level: 'gpu',
      kvCache,
      needGb: need,
      availableGb: vram,
      offloadGb: 0,
      tokensPerSec: estimateTokensPerSec(model, gpu),
      fits: true,
      allowed: true,
      agentReady,
      ...(agentReady ? {} : { reason: model.agentic ? 'small-context' : 'no-tools' }),
    };
  }
  // Не влезла в карту: часть слоёв уйдёт в оперативную память. Кеш — q4_0: q8_0 тем более
  // не влез, а каждый гигабайт кеша на карте выталкивает слой на процессор (L9, 15.10: с
  // q8_0 такой запуск уходил в общую память Windows — 0,6 ток/с). Окно здесь названо
  // человеком, поэтому, в отличие от `fitModel`, оно не урезается до агентского минимума.
  const offload = Math.max(0, need4 + GPU_RESERVE_GB - vram);
  const partial = offload <= ramForModelGb(ramGb) && offload < need4;
  return {
    level: partial ? 'partial' : 'none',
    kvCache: 'q4_0',
    needGb: need4,
    availableGb: vram,
    offloadGb: offload,
    tokensPerSec: partial ? estimateTokensPerSec(model, gpu, offload) : [0, 0],
    fits: false,
    allowed: partial && allowPartial,
    agentReady: false,
    reason: !model.agentic ? 'no-tools' : partial ? 'partial' : 'too-big',
  };
}

/** Почему вариант закрыт: не влезает при другом выборе или агенту мало окна. */
export type ChoiceBlock = 'too-big' | 'agent-min';

export interface ChoiceOption<T extends string | number> {
  value: T;
  /** Настоящее квантование, когда `value` — служебная метка (слой из Ollama). */
  label?: string;
  /** Файл забран из хранилища Ollama. */
  source?: 'ollama';
  /** Размер файла квантования, байт (для окна — нет). */
  sizeBytes?: number;
  needGb: number;
  availableGb: number;
  level: ModelFitLevel;
  /** Частичная выгрузка: вариант открыт только потому, что человек её разрешил. */
  partial: boolean;
  disabled: boolean;
  block?: ChoiceBlock;
}

/** Квантования модели при выбранном окне: что влезает, что нет — и сколько не хватает. */
export function quantOptions(
  model: CatalogModel,
  gpu: HardwareGpu | undefined,
  ramGb: number,
  context: number,
  allowPartial = false,
): ChoiceOption<string>[] {
  return model.quants.map((quant) => {
    const fit = fitChoice(model, gpu, ramGb, { quant: quant.id, context }, allowPartial);
    return {
      value: quant.id,
      ...(quant.label ? { label: quant.label } : {}),
      ...(quant.source ? { source: quant.source } : {}),
      sizeBytes: quant.sizeBytes,
      needGb: fit.needGb,
      availableGb: fit.availableGb,
      level: fit.level,
      partial: fit.level === 'partial' && fit.allowed,
      disabled: !fit.allowed,
      ...(fit.allowed ? {} : { block: 'too-big' as const }),
    };
  });
}

/**
 * Окна модели при выбранном квантовании. Меньше `AGENT_MIN_CONTEXT` закрыто для
 * агентов: один системный промпт Claude Code занимает ~20 тысяч токенов. Модели,
 * которая агентом не работает, ограничение ни к чему.
 */
export function contextOptions(
  model: CatalogModel,
  gpu: HardwareGpu | undefined,
  ramGb: number,
  quantId: string,
  allowPartial = false,
): ChoiceOption<number>[] {
  return contextStepsFor(model).map((context) => {
    const fit = fitChoice(model, gpu, ramGb, { quant: quantId, context }, allowPartial);
    const tooSmall = model.agentic && context < AGENT_MIN_CONTEXT;
    const block: ChoiceBlock | undefined = tooSmall
      ? 'agent-min'
      : fit.allowed
        ? undefined
        : 'too-big';
    return {
      value: context,
      needGb: fit.needGb,
      availableGb: fit.availableGb,
      level: fit.level,
      partial: fit.level === 'partial' && fit.allowed,
      disabled: block !== undefined,
      ...(block ? { block } : {}),
    };
  });
}

/**
 * Что показывают селекторы строки: сохранённое человеком, а не названное — как
 * поднял бы сервер (скачанное квантование, иначе умолчание каталога; окно — из
 * подбора под карту, то есть меньшее из `defaultContext` и того, что влезло).
 */
export function resolveChoice(
  model: CatalogModel,
  gpu: HardwareGpu | undefined,
  ramGb: number,
  stored: ModelChoiceInfo | undefined,
  activeQuant?: string,
): { quant: string; context: number; allowPartial: boolean } {
  const known = (id: string | undefined): string | undefined =>
    id && model.quants.some((quant) => quant.id === id) ? id : undefined;
  const quant =
    known(stored?.quant) ??
    known(activeQuant) ??
    known(model.defaultQuant) ??
    model.quants[0]?.id ??
    '';
  const context = stored?.context
    ? Math.min(stored.context, model.contextMax)
    : fitModel(model, gpu, ramGb, quant).context;
  return { quant, context, allowPartial: stored?.allowPartial ?? false };
}

/**
 * Качество квантования числом: больше — лучше. Порядок из задачи: Q8_0 > Q6_K > Q5_K_M >
 * Q5_K_S > UD-Q4_K_XL > Q4_K_M > Q4_K_S > IQ4_XS > Q3… Основа — число бит, поверх — размер
 * варианта (XL выше M, M выше S) и семейство (старые _0/_1 и IQ чуть ниже K-квантов).
 * Не разобрали — `undefined`: такой файл в рекомендации не участвует.
 */
export function quantQuality(id: string): number | undefined {
  const match = /^(?:UD-)?(IQ|Q)(\d)(?:_(K|0|1))?(?:_(XXS|XS|S|M|L|XL))?$/.exec(id);
  if (!match) return undefined;
  const bits = Number(match[2]);
  const size = { XXS: 1, XS: 2, S: 4, M: 6, L: 8, XL: 9 }[match[4] as 'S'] ?? 5;
  const legacy = match[3] === '0' || match[3] === '1' ? -3 : 0;
  const imatrix = match[1] === 'IQ' ? -1 : 0;
  return bits * 100 + size + legacy + imatrix;
}

/** Ниже этого — «заметно хуже»: Q3 и меньше (IQ4_XS и выше качеством не обижены). */
const LOW_QUALITY_BELOW = 400;
/** Выше Q6_K выигрыш в качестве ничтожен: лучше запас под контекст. */
const RECOMMEND_QUALITY_CAP = 605;

/** Подпись качества для списка: `low` — Q2/IQ2/Q3, о них говорим прямо. */
export function isLowQuality(id: string): boolean {
  const quality = quantQuality(id);
  return quality !== undefined && quality < LOW_QUALITY_BELOW;
}

export type ChoiceRecommendation =
  | { status: 'ok'; quant: string; context: number; lowQuality: boolean }
  /** Даже на 32K ни один файл не помещается на карту целиком. */
  | { status: 'none' };

/**
 * Что рекомендуется на ЭТОЙ машине, по свободной сейчас видеопамяти. Агенту нужен
 * контекст важнее, чем лишняя ступень квантования: начинаем с окна по умолчанию
 * (не выше предела модели), берём лучшее квантование, которое целиком лежит на
 * карте, но не выше Q6_K. Ничего не лезет — окно шагом вниз (до 32K), и снова.
 * Всё ещё ничего — лучшее из Q3 и ниже, с пометкой. На 32K пусто — рекомендации нет.
 */
export function recommendChoice(
  model: CatalogModel,
  gpu: HardwareGpu | undefined,
  ramGb: number,
): ChoiceRecommendation {
  const start = Math.min(model.defaultContext ?? 65_536, model.contextMax);
  const floor = model.agentic ? Math.min(AGENT_MIN_CONTEXT, model.contextMax) : 8_192;
  const contexts = contextStepsFor(model)
    .filter((step) => step <= start && step >= floor)
    .reverse();
  const ranked = model.quants
    .map((quant) => ({ id: quant.id, quality: quantQuality(quant.label ?? quant.id) }))
    .filter((item): item is { id: string; quality: number } => item.quality !== undefined)
    .sort((a, b) => b.quality - a.quality);
  const wholeOnDevice = (quant: string, context: number): boolean =>
    fitChoice(model, gpu, ramGb, { quant, context }).fits;
  const pickAt = (lowQuality: boolean, context: number): string | undefined =>
    ranked.find(
      (item) =>
        item.quality <= RECOMMEND_QUALITY_CAP &&
        item.quality < LOW_QUALITY_BELOW === lowQuality &&
        wholeOnDevice(item.id, context),
    )?.id;
  for (const lowQuality of [false, true])
    for (const context of contexts) {
      const quant = pickAt(lowQuality, context);
      if (quant) return { status: 'ok', quant, context, lowQuality };
    }
  return { status: 'none' };
}

/**
 * Замер снят не с тем, с чем модель поднимется сейчас: `other` — окно или
 * квантование другие, `unknown` — замер до 14.10, с чем он снят, не записано.
 * Совпало — `undefined`.
 */
export function benchStale(
  bench: Pick<ModelBench, 'context' | 'quant'>,
  pick: { quant: string; context: number },
): 'other' | 'unknown' | undefined {
  if (bench.context === undefined || bench.quant === undefined) return 'unknown';
  return bench.context === pick.context && bench.quant === pick.quant ? undefined : 'other';
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
/**
 * Через сколько минут простоя модель выгружается, когда её не держат. Короткий срок —
 * умолчание: кеш разговора перед сном уходит на диск, и возврат стоит загрузки модели и
 * подъёма кеша (секунды), а занятая видеопамять мешает всему остальному на карте.
 */
export const localIdleMinutes = [5, 15, 60] as const;
export type LocalIdleMinutes = (typeof localIdleMinutes)[number];
export const LOCAL_IDLE_MINUTES_DEFAULT: LocalIdleMinutes = 5;
export function isLocalIdleMinutes(value: unknown): value is LocalIdleMinutes {
  return (localIdleMinutes as readonly unknown[]).includes(value);
}
export const localKeepLoadedBodySchema = object({
  keepLoaded: boolean(),
  idleMinutes: number().refine(isLocalIdleMinutes).optional(),
});
export const localKeepAwakeBodySchema = object({ keepAwake: boolean() });

/** Карта, на которую считать подбор: при счёте на процессоре — никакая. */
export function deviceGpu(
  hardware: Pick<HardwareInfo, 'gpus'>,
  device: LocalDevice,
): HardwareGpu | undefined {
  return device === 'cpu' ? undefined : hardware.gpus[0];
}

// ── Ответ раздела ─────────────────────────────────────────────────────────

/**
 * Наименьшая сборка llama.cpp (номер после `b`), которую панель поднимает без
 * предупреждения: в ней есть `--spec-type draft-mtp` и родной `/v1/messages` с
 * `count_tokens`. Закреплённая сборка — `data/llama-release.json` сервера.
 */
export const MIN_LLAMA_BUILD = 11583;

/** Идентификатор контура локальной модели — в модуле без zod: его берёт и телефон. */
export { LOCAL_PLATFORM_ID } from './platform-layers.ts';

export const runtimeSources = ['system', 'panel', 'none'] as const;
export type RuntimeSource = (typeof runtimeSources)[number];

export interface LocalRuntimeInfo {
  /** Чьим исполняемым файлом поднимается сервер панели. */
  source: RuntimeSource;
  /** Путь к исполняемому файлу; пусто — не найден. */
  binary: string;
  /** Сборка llama.cpp: `b11583`; пусто — своей сборки нет. */
  version: string;
  /** Сборка старше `MIN_LLAMA_BUILD` — в ней нет возможностей, на которые рассчитан каталог. */
  outdated: boolean;
  /** `llama-server`, указанный в `LLAMA_SERVER_BINARY`; панель своей сборки не ищет в системе. */
  systemBinary: string;
  /** Последняя версия для скачивания (если известна) и её размер. */
  latest?: { version: string; sizeBytes: number };
}

/**
 * Что сервер моделей делает с запросом чата (`GET /api/local-models/activity`, L6).
 * `idle` — запроса в пути нет; `starting` — сервер не отвечает (присмотр поднимает);
 * `loading` — модель грузится в память; `queued` — запрос ушёл, слот его ещё не взял;
 * `prompt` — разбор промпта (`filled` из `promptTokens`); `generating` — пишет ответ
 * (`decoded` токенов).
 */
export type LocalActivityPhase =
  'idle' | 'starting' | 'loading' | 'queued' | 'prompt' | 'generating';

/**
 * Запас под ответ модели у локального окна: промпт, подошедший к окну вплотную, оставил бы
 * модели место на пару слов. Шлюз отказывает «prompt is too long» по окну за его вычетом.
 */
export const LOCAL_REPLY_RESERVE_TOKENS = 4_096;
/**
 * Сколько окна сверх слоя и запаса под ответ нужно самому разговору: меньше — и Claude Code
 * сжимает историю на каждом ходу, а сжатие, не влезающее в окно вместе со слоем, не удаётся.
 */
export const LOCAL_LAYER_ROOM_TOKENS = 16_384;

/** Окно, в котором слой (системный промпт и инструменты) оставляет место разговору. */
export function layerNeedContext(layerTokens: number): number {
  return Math.ceil(layerTokens) + LOCAL_REPLY_RESERVE_TOKENS + LOCAL_LAYER_ROOM_TOKENS;
}

/**
 * Слой локального прогона против окна сервера (L6, 15.10). Полный набор панели — ~66 тыс.
 * токенов системного промпта и описаний инструментов; при окне 65 536 каждый ход отказывался
 * «Prompt is too long» ещё до работы, и человек не видел ни чисел, ни выхода. Слой меряет
 * шлюз по настоящему запросу (доля системного промпта и инструментов в счёте токенов).
 */
export interface LocalLayerFit {
  /** Токенов в слое: системный промпт и описания инструментов. */
  tokens: number;
  /** Окно сервера, с которым сравнивали (идущего, иначе того, с которым он поднимется). */
  context: number;
  /** Сколько токенов отведено промпту при этом окне: окно за вычетом запаса под ответ. */
  limit: number;
  /** Слой оставляет разговору хотя бы `LOCAL_LAYER_ROOM_TOKENS`. */
  fits: boolean;
  /** Когда замерено, мс с начала эпохи. */
  at: number;
  /**
   * Чем починить, когда не влезает: наименьшее окно, вмещающее слой и разговор; `quant` —
   * когда нынешнее квантование с таким окном целиком на карту не ляжет, а это ляжет. Нет поля —
   * окна с местом под слой у модели нет.
   */
  fix?: { context: number; quant?: string };
  /** Разговор Claude Code, чей запрос замерен. */
  session?: string;
  /**
   * Токенов описаний MCP, которые этот разговор шлёт целиком при включённом поиске
   * инструментов: начат без поиска, и CLI держит его набор инструментов неизменным.
   * В новом разговоре они подгружаются по требованию.
   */
  frozenTools?: number;
}

export interface LocalActivity {
  phase: LocalActivityPhase;
  /** Слой прогона против окна сервера: последний замер шлюза. */
  layer?: LocalLayerFit;
  model?: string;
  quant?: string;
  /** Окно сервера, токенов. */
  context?: number;
  /** Запросов в пути. */
  inFlight: number;
  startedAt?: number;
  /** Сколько токенов в запросе — счёт шлюза (оценка или точный счёт сервера). */
  promptTokens?: number;
  /** Токенов промпта уже в кеше слота. */
  filled?: number;
  /** Токенов ответа выдано. */
  decoded?: number;
  phaseSince?: number;
  /** Сколько ничего не двигалось, мс. */
  silentMs?: number;
  /** Через сколько тишины запрос обрывается и повторяется, мс. */
  stallMs?: number;
  /** Последний обрыв по тишине: когда и после скольких секунд. */
  lastStall?: { at: number; seconds: number };
  /** Когда ушёл последний запрос к серверу: ход, не сделавший ни одного, ещё готовит первый. */
  lastRequestAt?: number;
  /**
   * Последний запрос, на который сервер ответил отказом (`status` — его код, `message` — его
   * текст). Удачный ответ стирает. Без этого чат на шаблоне, падавшем на каждом запросе,
   * показывал «агент выполняет инструменты», пока Claude Code молча повторял 500.
   */
  lastError?: { at: number; status: number; message: string };
}

export interface LocalServerInfo {
  running: boolean;
  port: number;
  baseUrl: string;
  pid?: number;
  /**
   * Модель, загруженная в память сейчас: llama-server держит одну и до остановки.
   * `vramBytes` — оценка (сервер видеопамять не называет), `until` пусто.
   */
  loaded: { tag: string; vramBytes: number; sizeBytes: number; until: string; quant?: string }[];
  /** Модель и квантование, с которыми поднят сервер. */
  model?: string;
  quant?: string;
  /** Идёт ли генерация с предсказанием нескольких токенов. */
  mtp?: boolean;
  /** Контекст, с которым поднят сервер. */
  context: number;
  /** Тип кеша контекста запущенного сервера; не поднят — нет. */
  kvCache?: KvCacheType;
  /** Устройство, с которым поднят сервер; не поднят — выбранное. */
  device: LocalDevice;
  /**
   * Сервер жив, но модель выгружена по простою (`--sleep-idle-seconds`): видеопамять и
   * кеш свободны, первый запрос загрузит модель заново. `loaded` при этом пуст.
   */
  sleeping?: boolean;
  /** «Держать загруженной»: простой модель не выгружает. */
  keepLoaded: boolean;
  /** Через сколько секунд простоя модель выгружается, когда её не держат. */
  idleSeconds: number;
  /** Выбранный срок выгрузки, мин: применяется при следующем запуске, если сервер идёт со старым. */
  idleMinutes: LocalIdleMinutes;
  /** «Не давать системе уснуть, пока идёт локальный прогон» (умолчание — включено). */
  keepAwake: boolean;
  /** Запрет сна системе стоит прямо сейчас: идёт локальный прогон и выключатель включён. */
  awake?: boolean;
  /**
   * Присмотр за сервером: он упал и поднят заново (`restarted`), подъём не удался
   * (`failed`) или потолок подъёмов исчерпан (`gave-up`, дальше панель не пытается).
   */
  notice?: LocalServerNotice;
  /** Настройка сохранена, а перезапуск ждёт конца идущего прогона («применится после текущего прогона»). */
  restartPending?: boolean;
  /** Отложенный перезапуск не удался и после повтора: причина; настройка сохранена, применится при следующем запуске сервера. */
  restartError?: string;
  /** Слой прогона против окна этого сервера (или того, с которым он поднимется): последний замер шлюза. */
  layer?: LocalLayerFit;
  error?: string;
}

export interface LocalServerNotice {
  kind: 'restarted' | 'gave-up' | 'failed';
  /** Когда случилось, мс с начала эпохи. */
  at: number;
  /** Сколько подъёмов предпринято с последнего удачного (после потолка в 3 за 10 минут растёт по одной попытке за 10 минут). */
  restarts: number;
  /** При `gave-up`: когда панель попробует снова, мс с начала эпохи. */
  nextTryAt?: number;
  reason?: string;
}

export interface InstalledModel {
  tag: string;
  /** Метка квантования файла; у импортированной из Ollama — служебная `Ollama`. */
  quant?: string;
  /** Настоящее квантование из заголовка GGUF (`Q4_K_M`), когда `quant` — служебная метка. */
  quantLabel?: string;
  /** Откуда файл: Hugging Face или хранилище Ollama (жёсткая ссылка на тот же слой). */
  source?: 'hf' | 'ollama';
  /** Все скачанные квантования этой модели; `quant` — то, с которым модель поднимается. */
  quants?: string[];
  /** Файлы скачанных квантований: размер и сколько места вернёт удаление (кнопка у каждого). */
  files?: InstalledFile[];
  sizeBytes: number;
  modifiedAt: string;
  /** Есть ли модель в каталоге панели. */
  known: boolean;
  /** Последний замер на этой машине. */
  bench?: ModelBench;
}

/** Скачанный файл одного квантования модели. */
export interface InstalledFile {
  /** Квантование; у забранного из Ollama — служебная метка `Ollama`. */
  quant: string;
  /** Настоящее квантование из заголовка GGUF, когда `quant` служебный. */
  quantLabel?: string;
  source: 'hf' | 'ollama';
  sizeBytes: number;
  /**
   * Сколько места вернёт удаление. У жёсткой ссылки на файл Ollama — 0: удаляется
   * только ссылка панели, сами байты остаются у Ollama.
   */
  freesBytes: number;
}

/** Ответ на удаление: какие квантования убраны и сколько места вернулось (с недокачанными хвостами). */
export interface LocalRemoveResult {
  tag: string;
  removed: string[];
  freedBytes: number;
}

/** `DELETE /api/local-models/models/:tag?quant=` — без `quant` удаляется вся модель. */
export const localRemoveQuerySchema = object({
  quant: string().min(1).max(80).optional(),
});

/** Строка выбора квантования: что за файл, скачан ли и как ляжет на эту карту. */
export interface LocalQuantRow extends ModelQuant {
  installed: boolean;
  /** Квантование, с которым модель поднимется сейчас. */
  active: boolean;
  /** Подбор под эту карту для этого квантования: контекст, кеш, память, скорость. */
  fit: Pick<ModelFit, 'level' | 'context' | 'kvCache' | 'needGb' | 'tokensPerSec' | 'agentReady'>;
}

export interface LocalQuantsInfo {
  tag: string;
  repo: string;
  /** `hf` — список взят из дерева репозитория сейчас, `catalog` — снимок каталога (нет сети). */
  from: 'hf' | 'catalog';
  defaultQuant: string;
  rows: LocalQuantRow[];
}

export interface ModelBench {
  tokensPerSec: number;
  promptTokensPerSec: number;
  measuredAt: string;
  gpu: string;
  /** Где считал сервер при замере; у замеров до 07.10 нет — то была видеокарта. */
  device?: LocalDevice;
  /**
   * С чем поднят сервер при замере: окно, квантование, тип кеша и куда легли слои.
   * Скорость зависит от всего этого, поэтому замер при другом окне или квантовании
   * считается устаревшим (`benchStale`). У замеров до 14.10 полей нет.
   */
  context?: number;
  quant?: string;
  kvCache?: KvCacheType;
  offload?: 'all' | 'fit' | 'none';
}

export const localJobKinds = ['runtime', 'model', 'qwen-code', 'server'] as const;
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
  /** Модели из хранилища Ollama, которые можно забрать без скачивания (жёсткая ссылка на слой). */
  importable: { tag: string; sizeBytes: number }[];
  /** Модели из хранилища Ollama, которых llama.cpp не открыл: их предлагается скачать заново. */
  importFailed: { tag: string; reason: string }[];
  jobs: LocalJob[];
  connect: LocalConnectInfo;
  /** Выбранное устройство счёта (умолчание — видеокарта). */
  device: LocalDevice;
  /** Что человек выбрал для каждой модели: квантование, окно, частичная выгрузка. Нет записи — подбор. */
  choices: Record<string, ModelChoiceInfo>;
  claude: LocalClaudeInfo;
  qwenCode: QwenCodeInfo;
  kit: { claude: KitMode; qwen: KitMode; variant: 'standard' | 'local' };
  /** Сколько занимает весь каталог `.local-models`, байт. */
  diskUsedBytes: number;
}

/**
 * Модель и, по желанию, как её поднять: квантование (`Q4_K_M`), окно контекста и
 * тип кеша. Не названное берётся из подбора под эту карту; названное запоминается.
 */
export const localModelBodySchema = object({
  tag: string().min(1).max(200),
  quant: string().min(1).max(80).optional(),
  context: number().int().min(2048).max(2_097_152).optional(),
  kvCache: zodEnum(kvCacheTypes).optional(),
});
export type LocalModelBody = Infer<typeof localModelBodySchema>;
/**
 * Выбор для модели: квантование и окно (оба с экрана выбора) и разрешение
 * делить модель между картой и оперативной памятью. Запоминается на сервере.
 */
export const localChoiceBodySchema = object({
  tag: string().min(1).max(200),
  quant: string().min(1).max(80).optional(),
  context: number().int().min(2048).max(2_097_152).optional(),
  allowPartial: boolean().optional(),
});
export type LocalChoiceBody = Infer<typeof localChoiceBodySchema>;
/** Ответ на выбор: что запомнено и, если выбор менял идущий сервер, работа перезапуска. */
export interface LocalChoiceResult {
  choice: ModelChoiceInfo;
  restart?: LocalJob;
}
/** «Любая модель»: `владелец/репозиторий` или ссылка на репозиторий Hugging Face. */
export const localCustomBodySchema = object({ input: string().min(3).max(300) });
export const localPullBodySchema = localModelBodySchema;
export const localKitBodySchema = object({
  provider: zodEnum(['claude', 'qwen']),
  mode: kitModeSchema,
});
export const localConnectBodySchema = localModelBodySchema;

/**
 * Кнопка локальной модели в шапке чата: `on` — поднять модель, выбранную агентам, с её
 * настройками и пустить чаты в неё; `off` — вернуть облако и остановить сервер. Ответ —
 * `LocalConnectInfo`.
 */
export const localToggleBodySchema = object({
  on: boolean(),
  /** Включить ЭТУ скачанную модель и сделать её моделью агентов (окно кнопки, когда выбора нет). */
  tag: string().min(1).max(200).optional(),
});

// ── MCP-серверы в локальном прогоне (L4) ─────────────────────────────────────

/**
 * Основа запроса локального прогона с облегчённым набором (`--strict-mcp-config`
 * + десять инструментов), токенов. Замер 14.10 настоящим `claude` 2.1.286 со слоем
 * человека: 12 598 из них 1297 — системный промпт CLI, 3852 — правила, 2823 — хуки,
 * 4590 — схемы десяти инструментов. Слой человека у каждого свой, поэтому число —
 * «около»; настоящий счёт показывает окно разговора.
 */
export const LOCAL_LEAN_BASE_TOKENS = 12_600;

/** Меньше этого на разговор не оставляют: сжатие истории шло бы на каждом ходе. */
export const LOCAL_MCP_MIN_HEADROOM_TOKENS = 4_000;

/**
 * Резерв под служебное в расчёте сжатия Claude Code: сжатие срабатывает при
 * `окно − min(вывод, 20000) − 13000` (замер на 2.1.286, `code-map-local-models`).
 */
export const LOCAL_COMPACT_RESERVE_TOKENS = 13_000;

export type LocalMcpScope = 'user' | 'project';

/** Один MCP-сервер, который можно взять в локальный прогон проекта. */
export interface LocalMcpServer {
  id: string;
  /** Откуда запись: `~/.claude.json` или `.mcp.json` проекта. */
  scope: LocalMcpScope;
  transport: 'stdio' | 'http' | 'sse';
  /** Стоимость его инструментов в запросе, токенов; нет замера — `null`. */
  tokens: number | null;
  /** Сколько инструментов отдал сервер. */
  tools: number | null;
  /** Чем считано: счётом токенов сервера моделей или прикидкой по символам (сервер спит или не запущен). */
  source?: 'server' | 'estimate';
  /** Почему замерить не вышло (сервер не отвечает, нужен вход); слова сервера. */
  error?: string;
  picked: boolean;
}

/** Ответ `GET /api/local-models/mcp`: серверы проекта, выбор и запас окна. */
export interface LocalMcpInfo {
  project: string;
  /** Окно сервера моделей (или наименьшее окно агента, пока сервер не поднят). */
  context: number;
  /** Сколько токенов запроса до сжатия истории. */
  compactAt: number;
  /** Основа запроса без MCP (`LOCAL_LEAN_BASE_TOKENS`). */
  baseTokens: number;
  /** Запас на разговор при текущем выборе: `compactAt − основа − выбранное`. */
  headroom: number;
  servers: LocalMcpServer[];
  picked: string[];
}

/** Запас на разговор при выборе `picked`; отрицательный — основа и серверы не влезают до сжатия. */
export function localMcpHeadroom(
  info: Pick<LocalMcpInfo, 'compactAt' | 'baseTokens' | 'servers'>,
  picked: readonly string[],
): number {
  const chosen = new Set(picked);
  const used = info.servers
    .filter((server) => chosen.has(server.id))
    .reduce((sum, server) => sum + (server.tokens ?? 0), 0);
  return info.compactAt - info.baseTokens - used;
}

/**
 * Можно ли добавить сервер к выбору: после него остаётся не меньше `LOCAL_MCP_MIN_HEADROOM_TOKENS`.
 * Сервер без цены (не замерен или не ответил) не берётся: влезет ли он, неизвестно, а
 * неответивший уехал бы прогону мёртвым.
 */
export function localMcpFits(
  info: Pick<LocalMcpInfo, 'compactAt' | 'baseTokens' | 'servers'>,
  picked: readonly string[],
  id: string,
): boolean {
  if (picked.includes(id)) return true;
  if ((info.servers.find((server) => server.id === id)?.tokens ?? null) === null) return false;
  return localMcpHeadroom(info, [...picked, id]) >= LOCAL_MCP_MIN_HEADROOM_TOKENS;
}

export const localMcpPickBodySchema = object({
  project: string().min(1).max(1000),
  servers: array(string().min(1).max(200)).max(100),
});
export type LocalMcpPickBody = Infer<typeof localMcpPickBodySchema>;

export const localMcpMeasureBodySchema = object({
  project: string().min(1).max(1000),
  /** Какие серверы замерить; нет — все без замера. */
  ids: array(string().min(1).max(200)).max(100).optional(),
});
export type LocalMcpMeasureBody = Infer<typeof localMcpMeasureBodySchema>;
