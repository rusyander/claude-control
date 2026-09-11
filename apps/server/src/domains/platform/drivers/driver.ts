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
