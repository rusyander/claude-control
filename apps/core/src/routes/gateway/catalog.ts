import type { PlatformModelInfo, PlatformModelPrice } from '@agentdeck/contracts/platform';

/**
 * Разбор каталога моделей шлюза (перенос `domains/platform/drivers/catalog.ts` панели, строка
 * миграции 10:127). Шлюзы называют одно и то же разными полями (OpenAI, OpenRouter, LiteLLM,
 * vLLM, Mistral, Azure); правило одно: берётся только ОБЪЯВЛЕННОЕ, угаданного нет. Окно,
 * возможность или цена, которых каталог не назвал, остаются пустыми — и факт маршрута честно
 * отвечает «не объявлено» (цена — только токены, 11 R:PR-06).
 */

type FlagRule = { at: string } | { at: string; has: string[] };
type KindRule = { at: string } | { at: string; kind: string };
interface PriceRule {
  input: string;
  output: string;
  cacheRead?: string;
  cacheWrite?: string;
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

const CONTEXT_FIELDS = [
  'context_length',
  'context_window',
  'max_context_tokens',
  'max_input_tokens',
  'max_model_len',
  'max_context_length',
  'top_provider.context_length',
];

const OUTPUT_FIELDS = [
  'max_output_tokens',
  'max_tokens',
  'output_limit',
  'max_completion_tokens',
  'top_provider.max_completion_tokens',
];

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

const PRICE_RULES: PriceRule[] = [
  // OpenRouter: строки, доллары за ТОКЕН.
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

/** Список моделей ответа: массив или поле `data`; иначе `undefined` — это не каталог. */
export function catalogItems(payload: unknown): unknown[] | undefined {
  if (Array.isArray(payload)) return payload;
  if (!payload || typeof payload !== 'object') return undefined;
  const data = (payload as { data?: unknown }).data;
  return Array.isArray(data) ? data : undefined;
}

export function readPlatformModels(payload: unknown): PlatformModelInfo[] {
  const models: PlatformModelInfo[] = [];
  for (const item of catalogItems(payload) ?? []) {
    const model = readOneModel(item);
    if (model) models.push(model);
  }
  return models;
}

/** Чатовая ли модель: вид не назван — считается чатовой (так её и отдаёт совместимый шлюз). */
export function isChatModel(model: PlatformModelInfo): boolean {
  return model.kind === undefined || model.kind === 'chat';
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
    // Объявленное `false` — тоже знание («картинки не принимает»), его не схлопываем в молчание.
    if (flag !== undefined) Object.assign(model, { [field]: flag });
  }
  const price = pickPrice(fields);
  if (price) model.price = price;
  return model;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

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
    // Ноль и отрицательное — мусор, а не предел: «окно 0» хуже, чем «не объявлено».
    if (typeof value === 'number' && Number.isFinite(value) && value > 0) return value;
  }
  return undefined;
}

function pickFlag(fields: Record<string, unknown>, rules: FlagRule[]): boolean | undefined {
  for (const rule of rules) {
    const value = valueAt(fields, rule.at);
    if ('has' in rule) {
      // Объявленный список без искомого — «нет», а не молчание.
      if (Array.isArray(value)) return rule.has.some((wanted) => value.includes(wanted));
    } else if (typeof value === 'boolean') {
      return value;
    }
  }
  return undefined;
}

function pickPrice(fields: Record<string, unknown>): PlatformModelPrice | undefined {
  for (const rule of PRICE_RULES) {
    const input = perMillion(valueAt(fields, rule.input), rule.perTokens);
    const output = perMillion(valueAt(fields, rule.output), rule.perTokens);
    if (input === undefined || output === undefined) continue;
    const price: PlatformModelPrice = { input, output };
    const cacheRead = rule.cacheRead
      ? perMillion(valueAt(fields, rule.cacheRead), rule.perTokens)
      : undefined;
    if (cacheRead !== undefined) price.cacheRead = cacheRead;
    const cacheWrite = rule.cacheWrite
      ? perMillion(valueAt(fields, rule.cacheWrite), rule.perTokens)
      : undefined;
    if (cacheWrite !== undefined) price.cacheWrite = cacheWrite;
    return price;
  }
  return undefined;
}

function perMillion(value: unknown, perTokens: number): number | undefined {
  let number = NaN;
  if (typeof value === 'number') number = value;
  else if (typeof value === 'string' && value.trim()) number = Number(value);
  if (!Number.isFinite(number) || number < 0) return undefined;
  // 12 знаков: `0.00000015 × 10⁶` в двоичной арифметике — 0.15000000000000002.
  return Number(((number * 1_000_000) / perTokens).toPrecision(12));
}
