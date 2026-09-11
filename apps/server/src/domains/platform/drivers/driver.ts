import type {
  PlatformCapabilityFinding,
  PlatformDriverId,
  PlatformLimits,
  PlatformModelInfo,
} from '@agentdeck/contracts';
import type { CompromiseId } from '@agentdeck/contracts/compromises';

/**
 * Драйвер контура — ЕДИНСТВЕННОЕ место, где панель знает о конкретной
 * платформе.
 *
 * Инвариант 5 партии: ни одного `if (platform.id === 'enterprise-platform')` вне этой
 * папки. Всё остальное спрашивает возможности («умеет ли контур эмбеддинги»), а
 * не имя, — иначе второй контур в другой компании потребует переписать
 * половину панели.
 *
 * Драйвер НЕ ходит в сеть сам: транспорт, потолок ожидания и разбор пяти
 * исходов — общие и живут в `probe.ts`. Драйверу достаются адрес, заголовки и
 * уже разобранный ответ; он отвечает за смысл, а не за сокет.
 */

/**
 * Судьба поля запроса. Та же шкала, что у строки таблицы диалектов: драйвер
 * уточняет ею общие строки, а не заводит вторую таблицу.
 */
export type DriverFieldFate = 'mapped' | 'renamed' | 'lossy' | 'dropped';

/** Чем ЭТОТ контур отличается от общей судьбы поля. */
export interface DriverRequestField {
  /**
   * В каком диалекте назван `field`. `anthropic` — строка общей таблицы
   * перевода (её судьба и текст заменяются); `openai` — поле, которое контур
   * принимает схемой и до модели не доносит.
   *
   * Два диалекта в одном списке, а не два списка: потеря — это свойство
   * ПЛАТФОРМЫ, и разложив её по двум полям манифеста, мы бы позволили им
   * разойтись. Здесь же видно сразу, что `tools` теряется в обоих.
   */
  dialect: 'anthropic' | 'openai';
  field: string;
  fate: DriverFieldFate;
  note: string;
}

/**
 * Кадр потока, которого нет в диалекте OpenAI. Виды перечислены здесь, а не в
 * шлюзе, потому что решает их драйвер: шлюз знает, ЧТО делать с каждым видом,
 * и не знает, по какому полю его узнать.
 */
export type VendorFrameKind =
  | 'status'
  | 'reasoning'
  | 'sanitized'
  | 'guardrails'
  | 'anonymization'
  /**
   * Контур сам сообщил, что инструменты клиента до модели не дошли. Отдельный
   * вид, а не «незнакомый кадр»: это подтверждение `toolsPassthrough: false`
   * самой платформой, и молча выброшенным оно объясняло бы человеку пустой
   * ответ агента как каприз модели.
   */
  | 'tools-dropped';

/** Разобранный вендорный кадр: вид плюс то немногое, что из него нужно шлюзу. */
export interface VendorFrame {
  kind: VendorFrameKind;
  /**
   * Поле, по которому кадр узнан. Нужно дважды: им кадр вычищается, если рядом
   * с вердиктом приехал кусок ответа (наружу вендорное поле не уходит никогда),
   * и им же кадр называется в пометке о незнакомой форме.
   */
  field: string;
  /** Стадия контура (`kind === 'status'`). */
  stage?: string;
  /**
   * Тело вердикта — из него шлюз читает НАЗВАНИЯ сработавших проверок своим
   * белым списком. Драйвер сюда кладёт нужный уровень вложенности, а не весь
   * кадр: где лежит перечень, знает платформа.
   */
  verdict?: unknown;
  /** Проверки оборвали поток (`kind === 'guardrails'`). */
  interrupted?: boolean;
  /**
   * Карта подмены платформы «метка → значение» (`kind === 'anonymization'`).
   *
   * Нужна прослойке инструментов: аргумент вызова с чужой меткой вместо адреса
   * уедет в файл ровно таким (Р11), поэтому карта разворачивается ДО синтеза
   * `tool_use`. Направление здесь одно и обсуждению не подлежит — ключ это то,
   * что лежит в тексте, значение это то, чем его надо заменить; драйвер,
   * читающий кадр наоборот, обязан перевернуть карту у себя.
   */
  mapping?: Record<string, string>;
}

/**
 * Отказ, который умеет объяснить только эта платформа.
 *
 * Общие коды (400, 403, 404, 429, 5xx) читаются одинаково у любого шлюза и
 * живут в таблице `status.ts`. Сюда попадает ровно то, что панель знает про
 * КОНКРЕТНЫЙ контур: код, которого у других нет (451), и код, чья причина у
 * других другая (401 у платформа компании означает пять разных вещей — у произвольного
 * шлюза это утверждение было бы выдумкой).
 */
export interface DriverStatusRow {
  /** Код, которым ответил контур. */
  upstream: number;
  /** Код, который увидит клиент: у 451 это 400 — его понимают все клиенты. */
  status: number;
  code: string;
  message: string;
  /** В теле лежит перечень сработавших проверок: читать его белым списком. */
  violations?: boolean;
}

/**
 * Ручка контура (Р5). Две судьбы, и третьей нет: либо человек может задать
 * это в запросе, либо только увидеть в ответе. Ручка без механизма на экран
 * не выводится — поэтому список объявляет драйвер, а не интерфейс.
 */
export interface DriverControl {
  id: string;
  title: string;
  /** `request` — задаётся в запросе; `observed` — только видно в ответе. */
  kind: 'request' | 'observed';
  detail: string;
}

/** Откуда у контура берутся картинки. */
export type DriverImages =
  /** Частью ответа модели `image_generation` в обычном `chat/completions`. */
  | 'chat-part'
  /** Отдельной ручкой OpenAI-вида `/v1/images/generations`. */
  | 'images-api'
  /** Ниоткуда: пункт в панели недоступен с названной причиной. */
  | 'none';

/** Что драйвер вычитал из удачного ответа списка моделей. */
export interface DriverReading {
  models: PlatformModelInfo[];
  capabilities: PlatformCapabilityFinding[];
  limits: PlatformLimits;
  /** Замечания обо всём контуре целиком. */
  notes: string[];
  /** Подписи, которыми объясняется этот ответ. */
  compromises: CompromiseId[];
}

export interface PlatformDriver {
  id: PlatformDriverId;
  /** Как называть контур человеку в тексте отказа. */
  title: string;
  /**
   * Адрес списка моделей. Базовый адрес берётся как есть: панель дописывает
   * только версию, и то лишь когда её в адресе нет (см. `versionedUrl`).
   */
  modelsUrl(baseUrl: string): string;
  /** Заголовки запроса. Ключ уходит ТОЛЬКО сюда и никуда больше. */
  headers(token: string | undefined): Record<string, string>;
  /** Смысл удачного ответа: что за модели и что из этого следует. */
  read(payload: unknown): DriverReading;
  /**
   * Подсказка про сам адрес, когда по нему ответил не модельный API. Живёт в
   * драйвере, потому что это ЗНАНИЕ О ПЛАТФОРМЕ: «публичный API обычно на
   * api.<домен>» верно для платформа компании и неверно для произвольного шлюза, который
   * человек поднял у себя под любым именем. Пусто — сказать нечего.
   */
  addressHint?(url: string): string | undefined;

  // --- Манифест (Т1). Ниже — то, что раньше жило в конвейере под одну
  // платформу. Конвейер спрашивает манифест и не знает имён контуров.

  /** Чем судьба полей запроса у этого контура отличается от общей таблицы. */
  requestFields: DriverRequestField[];

  /**
   * Вендорный кадр: и ЧТО это, и ЧТО в нём. `undefined` — кадр не наш, пусть
   * шлюз разбирает его как обычный.
   *
   * Читает драйвер, а не шлюз. Половинчатый вариант (драйвер узнаёт, шлюз
   * читает по именам `enterprise-platform_*`) был написан первым и разбирался ровно до
   * второй платформы: её кадр правильно назывался гардрейлами и читался пустым,
   * после чего оборванный проверками ответ уезжал клиенту как законченный.
   * Названия проверок из `verdict` шлюз всё же достаёт сам — белый список имён
   * общий, и текст, на котором сработали, не должен просочиться ни у кого.
   */
  readFrame(payload: Record<string, unknown>): VendorFrame | undefined;

  /**
   * Вендорные поля, которые контур кладёт в ЦЕЛЬНОЕ тело рядом с ответом. Их
   * шлюз выносит отдельными кадрами вперёд, иначе вердикт по выходу пропадает
   * при пересборке тела в поток.
   */
  vendorFields: readonly string[];

  /** Отказы, которые умеет объяснить только эта платформа. */
  statusRows: DriverStatusRow[];

  /** Откуда берутся картинки; `none` — пункт недоступен с причиной. */
  images: DriverImages;

  /**
   * Контур принимает описания инструментов клиента как есть. `false` означает,
   * что список инструментов до модели не доходит, и «агент через контур»
   * возможен только прослойкой (Т5).
   */
  toolsPassthrough: boolean;

  /** Контур принимает усилие рассуждения (`reasoning_effort` и родня). */
  effort: boolean;

  /** Ручки контура: что можно задать, а что только видно (Р5). */
  controls: DriverControl[];

  /**
   * Текст пробного запроса. Короткий и на своём языке: он уходит в модель за
   * деньги ключа, и его единственная задача — доказать, что путь работает.
   */
  smokePrompt: string;
}

/**
 * Дописать `/v1`, если его нет в адресе.
 *
 * Два вида адресов встречаются одинаково часто: корень API
 * (`https://api.example.ru`) и адрес вместе с версией
 * (`http://127.0.0.1:11434/v1`, как этого ждёт `OPENAI_BASE_URL`). Молча
 * приклеенная вторая `/v1` даёт 404, который человек читает как «контур не
 * работает», — поэтому версию дописываем ТОЛЬКО когда её в адресе нет.
 */
export function versionedUrl(baseUrl: string, path: string): string {
  const base = baseUrl.trim().replace(/\/+$/, '');
  return /\/v\d+[a-z]*$/.test(base) ? `${base}/${path}` : `${base}/v1/${path}`;
}

/**
 * Модели из ответа OpenAI-формы: `{ data: [{ id, … }] }`.
 *
 * Читается ВСЁ, что контур объявил, и НИЧЕГО сверх того. Поле, которого в ответе
 * нет, остаётся пустым и означает «контур молчит»: вывести зрение модели из
 * подстроки `vision` в её имени панель не станет ни за какие удобства — это и
 * есть инвариант 13, и цена ошибки тут не косметическая (человек выберет модель
 * под картинки, а она их не примет).
 *
 * Форма полей у платформ разная, поэтому каждое ищется по нескольким именам —
 * но именно ищется, а не угадывается: не нашли ни одного, значит не объявлено.
 */
export function readPlatformModels(payload: unknown): PlatformModelInfo[] {
  if (!payload || typeof payload !== 'object') return [];
  const data = (payload as { data?: unknown }).data;
  if (!Array.isArray(data)) return [];

  const models: PlatformModelInfo[] = [];
  for (const item of data) {
    const model = readOneModel(item);
    if (model) models.push(model);
  }
  return models;
}

/** Имена полей вида модели — от точного к общему. */
const KIND_FIELDS = ['kind', 'type', 'mode', 'model_type'];
/** Где платформы держат окно контекста. */
const CONTEXT_FIELDS = [
  'context_length',
  'context_window',
  'max_context_tokens',
  'max_input_tokens',
];
/** Где платформы держат потолок вывода. */
const OUTPUT_FIELDS = ['max_output_tokens', 'max_tokens', 'output_limit'];

/** Флаги возможностей: наше поле → имена, под которыми его публикуют. */
const FLAG_FIELDS: Array<[keyof PlatformModelInfo, string[]]> = [
  ['vision', ['supports_vision', 'vision']],
  ['functionCalling', ['supports_function_calling', 'function_calling', 'supports_tools']],
  ['jsonMode', ['supports_json_mode', 'json_mode', 'supports_response_schema']],
];

function readOneModel(item: unknown): PlatformModelInfo | undefined {
  if (!item || typeof item !== 'object') return undefined;
  const raw = item as Record<string, unknown>;

  const id = typeof raw.id === 'string' ? raw.id.trim() : '';
  if (!id) return undefined;

  const model: PlatformModelInfo = { id };

  // Часть платформ кладёт возможности в отдельный объект, часть — рядом с id.
  // Смотрим в оба места, но по одним и тем же именам полей.
  const nested = raw.capabilities && typeof raw.capabilities === 'object' ? raw.capabilities : {};
  const fields = { ...(nested as Record<string, unknown>), ...raw };

  const name = pickString(fields, ['name', 'display_name']);
  if (name && name !== id) model.name = name;

  const kind = pickString(fields, KIND_FIELDS);
  if (kind) model.kind = kind.toLowerCase();

  const ownedBy = pickString(fields, ['owned_by', 'owner', 'provider']);
  if (ownedBy) model.ownedBy = ownedBy;

  const context = pickNumber(fields, CONTEXT_FIELDS);
  if (context !== undefined) model.contextLimit = context;

  const output = pickNumber(fields, OUTPUT_FIELDS);
  if (output !== undefined) model.outputLimit = output;

  for (const [field, names] of FLAG_FIELDS) {
    const flag = pickBoolean(fields, names);
    // Именно `!== undefined`: объявленное `false` — это ЗНАНИЕ («модель картинки
    // не принимает»), и терять его, схлопывая в «не объявлено», нельзя.
    if (flag !== undefined) Object.assign(model, { [field]: flag });
  }

  return model;
}

function pickString(fields: Record<string, unknown>, names: string[]): string | undefined {
  for (const name of names) {
    const value = fields[name];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return undefined;
}

function pickNumber(fields: Record<string, unknown>, names: string[]): number | undefined {
  for (const name of names) {
    const value = fields[name];
    // Ноль и отрицательное — это не лимит, а мусор в ответе: показывать «окно
    // контекста: 0» хуже, чем не показывать ничего.
    if (typeof value === 'number' && Number.isFinite(value) && value > 0) return value;
  }
  return undefined;
}

function pickBoolean(fields: Record<string, unknown>, names: string[]): boolean | undefined {
  for (const name of names) {
    const value = fields[name];
    if (typeof value === 'boolean') return value;
  }
  return undefined;
}
