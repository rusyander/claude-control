import type { PlatformModelInfo, PlatformModelPrice } from '@agentdeck/contracts';

/**
 * Каталог моделей из ответа шлюза — ОДИН читатель на все драйверы и все шлюзы.
 *
 * Читается ВСЁ, что шлюз объявил, и НИЧЕГО сверх того. Поле, которого в ответе
 * нет, остаётся пустым и означает «шлюз молчит»: вывести зрение модели из
 * подстроки `vision` в её имени панель не станет ни за какие удобства — это и
 * есть инвариант 13, и цена ошибки тут не косметическая (человек выберет модель
 * под картинки, а она их не примет).
 *
 * Форма у шлюзов разная, и различие живёт В ТАБЛИЦАХ ниже, а не в ветках кода:
 * новый шлюз — это строка правила, а не `if (openrouter)`. До DRV-06 таблицы
 * знали одну форму, и vLLM терял окно контекста (`max_model_len`), OpenRouter —
 * зрение, инструменты, потолок вывода и цены, Mistral — вид модели, а Together
 * (голый массив вместо `data`) не проходил пробу вовсе.
 *
 * Путь поля пишется через точку (`top_provider.context_length`); объект
 * `capabilities` читается наравне с полями рядом с `id` — платформа компании и Azure кладут
 * возможности туда, остальные рядом.
 */

/** Правило флага: булево поле, либо объявленный список, в котором ищут значение. */
type FlagRule = { at: string } | { at: string; has: string[] };

/**
 * Правило вида: строковое поле берётся как есть, булево — даёт названный вид.
 * Порядок значим: точные имена поля вида, затем булевы возможности, и только
 * потом общее `type` — у Mistral там `base`/`fine-tuned`, а не вид модели.
 */
type KindRule = { at: string } | { at: string; kind: string };

/**
 * Правило цены. Единица записана В ПРАВИЛЕ, а не угадана по величине числа:
 * цена, прочитанная не в тех единицах, ошибается в миллион раз и выглядит на
 * карточке обычной суммой.
 */
interface PriceRule {
  input: string;
  output: string;
  cacheRead?: string;
  cacheWrite?: string;
  /** За сколько токенов опубликована цена. */
  perTokens: number;
}

const KIND_RULES: KindRule[] = [
  { at: 'kind' },
  { at: 'mode' },
  { at: 'model_type' },
  // Azure OpenAI и Mistral: вид не назван, но объявлен булевыми возможностями.
  { at: 'embeddings', kind: 'embedding' },
  { at: 'chat_completion', kind: 'chat' },
  { at: 'completion_chat', kind: 'chat' },
  { at: 'type' },
];

/** Где шлюзы держат окно контекста. */
const CONTEXT_FIELDS = [
  'context_length',
  'context_window',
  'max_context_tokens',
  'max_input_tokens',
  // vLLM
  'max_model_len',
  // Mistral
  'max_context_length',
  'top_provider.context_length',
];

/** Где шлюзы держат потолок вывода. */
const OUTPUT_FIELDS = [
  'max_output_tokens',
  'max_tokens',
  'output_limit',
  'max_completion_tokens',
  // OpenRouter: потолок провайдера, который реально обслужит запрос.
  'top_provider.max_completion_tokens',
];

/**
 * Флаги: наше поле → правила по порядку, первое ОБЪЯВЛЕННОЕ побеждает. Булево
 * поле стоит впереди списка: прямое «да/нет» точнее вывода из перечня.
 *
 * Имени модели здесь нет намеренно: `dall-e`, `flux` и `*-image` в
 * идентификаторе — не объявление, а совпадение, и пункт «Картинка» на нём вёл бы
 * человека в 400 от шлюза вместо честного «не объявлено».
 */
const FLAG_RULES: Array<[keyof PlatformModelInfo, FlagRule[]]> = [
  [
    'vision',
    [
      { at: 'supports_vision' },
      { at: 'vision' },
      { at: 'architecture.input_modalities', has: ['image'] },
    ],
  ],
  [
    'functionCalling',
    [
      { at: 'supports_function_calling' },
      { at: 'function_calling' },
      { at: 'supports_tools' },
      { at: 'supported_parameters', has: ['tools'] },
    ],
  ],
  [
    'jsonMode',
    [
      { at: 'supports_json_mode' },
      { at: 'json_mode' },
      { at: 'supports_response_schema' },
      { at: 'supported_parameters', has: ['response_format', 'structured_outputs'] },
    ],
  ],
  [
    'imageGeneration',
    [
      { at: 'image_generation' },
      { at: 'supports_image_generation' },
      { at: 'supports_images' },
      { at: 'architecture.output_modalities', has: ['image'] },
    ],
  ],
  [
    'reasoning',
    [
      { at: 'supports_reasoning' },
      { at: 'supported_parameters', has: ['reasoning', 'reasoning_effort', 'include_reasoning'] },
    ],
  ],
];

/**
 * Цены, чья единица известна. Together публикует `pricing.input/output`, но за
 * сколько токенов — живым ответом не сверено, и такая цена НЕ читается: лучше
 * «цены нет», чем сумма, неверная в миллион раз.
 *
 * Ступенчатые цены OpenRouter (`pricing.overrides` от `min_prompt_tokens`) не
 * читаются: оценка идёт по базовой ступени и остаётся оценкой со знаком «≈».
 */
const PRICE_RULES: PriceRule[] = [
  // OpenRouter: строки, доллары за ТОКЕН; сверено живым ответом 13.09.2026.
  {
    input: 'pricing.prompt',
    output: 'pricing.completion',
    cacheRead: 'pricing.input_cache_read',
    cacheWrite: 'pricing.input_cache_write',
    perTokens: 1,
  },
  // Имена LiteLLM: единица записана в самом имени поля.
  {
    input: 'input_cost_per_token',
    output: 'output_cost_per_token',
    cacheRead: 'cache_read_input_token_cost',
    cacheWrite: 'cache_creation_input_token_cost',
    perTokens: 1,
  },
];

/**
 * Список моделей в ответе: `{ data: [...] }` (OpenAI и почти все) или голый
 * массив (Together). Иначе `undefined` — ответ не каталог, и проба называет
 * это словами. Одна функция и для пробы, и для чтения: разойдясь, они дали бы
 * «проба прошла, моделей ноль».
 */
export function catalogItems(payload: unknown): unknown[] | undefined {
  if (Array.isArray(payload)) return payload;
  if (!payload || typeof payload !== 'object') return undefined;
  const data = (payload as { data?: unknown }).data;
  return Array.isArray(data) ? data : undefined;
}

export function readPlatformModels(payload: unknown): PlatformModelInfo[] {
  const items = catalogItems(payload) ?? [];
  const models: PlatformModelInfo[] = [];
  for (const item of items) {
    const model = readOneModel(item);
    if (model) models.push(model);
  }
  return models;
}

function readOneModel(item: unknown): PlatformModelInfo | undefined {
  if (!isRecord(item)) return undefined;

  const id = typeof item.id === 'string' ? item.id.trim() : '';
  if (!id) return undefined;

  const model: PlatformModelInfo = { id };
  const fields = { ...(isRecord(item.capabilities) ? item.capabilities : {}), ...item };

  const name = pickString(fields, ['name', 'display_name']);
  if (name && name !== id) model.name = name;

  const kind = pickKind(fields);
  if (kind) model.kind = kind.toLowerCase();

  const ownedBy = pickString(fields, ['owned_by', 'owner', 'provider']);
  if (ownedBy) model.ownedBy = ownedBy;

  const context = pickNumber(fields, CONTEXT_FIELDS);
  if (context !== undefined) model.contextLimit = context;

  const output = pickNumber(fields, OUTPUT_FIELDS);
  if (output !== undefined) model.outputLimit = output;

  for (const [field, rules] of FLAG_RULES) {
    const flag = pickFlag(fields, rules);
    // Именно `!== undefined`: объявленное `false` — это ЗНАНИЕ («модель картинки
    // не принимает»), и терять его, схлопывая в «не объявлено», нельзя.
    if (flag !== undefined) Object.assign(model, { [field]: flag });
  }

  const price = pickPrice(fields);
  if (price) model.price = price;

  return model;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

/** Значение по пути через точку; промежуточный не-объект — «не объявлено». */
function valueAt(fields: Record<string, unknown>, path: string): unknown {
  let current: unknown = fields;
  for (const key of path.split('.')) {
    if (!isRecord(current)) return undefined;
    current = current[key];
  }
  return current;
}

function pickString(fields: Record<string, unknown>, paths: string[]): string | undefined {
  for (const path of paths) {
    const value = valueAt(fields, path);
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return undefined;
}

function pickKind(fields: Record<string, unknown>): string | undefined {
  for (const rule of KIND_RULES) {
    const value = valueAt(fields, rule.at);
    if ('kind' in rule) {
      if (value === true) return rule.kind;
    } else if (typeof value === 'string' && value.trim()) {
      return value.trim();
    }
  }
  return undefined;
}

function pickNumber(fields: Record<string, unknown>, paths: string[]): number | undefined {
  for (const path of paths) {
    const value = valueAt(fields, path);
    // Ноль и отрицательное — это не лимит, а мусор в ответе: показывать «окно
    // контекста: 0» хуже, чем не показывать ничего.
    if (typeof value === 'number' && Number.isFinite(value) && value > 0) return value;
  }
  return undefined;
}

function pickFlag(fields: Record<string, unknown>, rules: FlagRule[]): boolean | undefined {
  for (const rule of rules) {
    const value = valueAt(fields, rule.at);
    if ('has' in rule) {
      // Объявленный список без искомого — это «нет», а не молчание: шлюз
      // перечислил, что модель принимает, и картинки там не назвал.
      if (Array.isArray(value)) return rule.has.some((wanted) => value.includes(wanted));
    } else if (typeof value === 'boolean') {
      return value;
    }
  }
  return undefined;
}

/** Первое правило, у которого объявлены ОБЕ цены, и обе не «неизвестно». */
function pickPrice(fields: Record<string, unknown>): PlatformModelPrice | undefined {
  for (const rule of PRICE_RULES) {
    const input = perMillion(valueAt(fields, rule.input), rule.perTokens);
    const output = perMillion(valueAt(fields, rule.output), rule.perTokens);
    if (input === undefined || output === undefined) continue;

    const price: PlatformModelPrice = { input, output };
    const cacheRead = optionalPrice(fields, rule.cacheRead, rule.perTokens);
    if (cacheRead !== undefined) price.cacheRead = cacheRead;
    const cacheWrite = optionalPrice(fields, rule.cacheWrite, rule.perTokens);
    if (cacheWrite !== undefined) price.cacheWrite = cacheWrite;
    return price;
  }
  return undefined;
}

function optionalPrice(
  fields: Record<string, unknown>,
  path: string | undefined,
  perTokens: number,
): number | undefined {
  return path ? perMillion(valueAt(fields, path), perTokens) : undefined;
}

/**
 * Цена в долларах за миллион. Число или числовая строка; отрицательное —
 * «неизвестно» (у OpenRouter `"-1"` стоит у маршрутизаторов, чья цена зависит от
 * выбранной модели). Ноль — законная цена бесплатной модели, не пропуск.
 */
function perMillion(value: unknown, perTokens: number): number | undefined {
  const number =
    typeof value === 'number'
      ? value
      : typeof value === 'string' && value.trim()
        ? Number(value)
        : NaN;
  if (!Number.isFinite(number) || number < 0) return undefined;
  // Точность до 12 знаков: `0.00000015 × 10⁶` в двоичной арифметике — это
  // 0.15000000000000002, и такой хвост уехал бы на экран.
  return Number(((number * 1_000_000) / perTokens).toPrecision(12));
}
