import { object, string, boolean, number, enum as zodEnum, type infer as Infer } from 'zod';

/**
 * Пресеты платформ — драйвер как ДАННЫЕ (аудит DRV-03).
 *
 * До этого модуля шлюз добавлялся кодом в шести местах: перечень в контракте,
 * реестр сервера, список и образец адреса на фронте, вторая схема сервера,
 * тексты. Кода у драйвера на деле два набора — у платформа компании (свои кадры, коды,
 * ручки) и у совместимого шлюза, который ничего о себе не утверждает. Всё, чем
 * LiteLLM отличается от vLLM, а Azure от OpenRouter, — это данные: где ключ, есть
 * ли родная ручка Anthropic, каким полем включаются размышления. Пресет и есть
 * эти данные поверх одной из двух баз; новый шлюз — строка здесь и две подписи
 * в словарях.
 *
 * Каждое утверждение пресета сверено с документацией шлюза (ссылка в `source`).
 * Не сверенное не объявляется: угаданная ручка даёт 404 на каждом ходе, а
 * «не объявлено» человек может переопределить на своём контуре
 * (`platform.manifest`), зная свой сервер.
 *
 * Живёт в контрактах, потому что читают оба берега: сервер собирает из пресета
 * драйвер, мастер показывает список, образец адреса и то, что пресет объявил.
 */

/** Код драйвера: у платформа компании свой, у всех остальных — совместимого шлюза. */
export type PlatformDriverBase = 'enterprise-platform' | 'openai-compat';

/** Пресеты в порядке показа. `enterprise-platform` первый — ради него раздел и заводится. */
export const platformDrivers = [
  'enterprise-platform',
  'openai-compat',
  'litellm',
  'vllm',
  'ollama',
  'openrouter',
  'azure-openai',
  'dashscope',
  'together',
] as const;

export type PlatformDriverId = (typeof platformDrivers)[number];

/**
 * Путь ручки относительно версии (`messages`, `images/generations`). Точек нет:
 * `..` в пути увёл бы запрос с ключом контура на чужую ручку того же хоста.
 */
const ENDPOINT_PATH = /^[a-z0-9][a-z0-9/_-]*$/;

/**
 * Поле на проводе, с точками для вложенного (`chat_template_kwargs.enable_thinking`).
 * Служебные имена объекта отвергаются: путь раскладывается по телу запроса, и
 * `__proto__` в нём подменил бы прототип вместо поля.
 */
const WIRE_PATH = /^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*){0,4}$/;
const OBJECT_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

export function isManifestEndpointPath(value: string): boolean {
  return value === '' || ENDPOINT_PATH.test(value);
}

export function isManifestWirePath(value: string): boolean {
  if (value === '') return true;
  return WIRE_PATH.test(value) && value.split('.').every((key) => !OBJECT_KEYS.has(key));
}

/** Потолок цельного ответа, который человек вправе объявить: час. */
export const PLATFORM_MANIFEST_TIMEOUT_MAX_SEC = 3600;

/**
 * Что пресет и контур могут сказать о шлюзе поверх кода базы. Отсутствующее
 * поле — «как у пресета», пустая строка — «не объявлено», даже если пресет
 * объявил: человек, знающий, что у его vLLM ручки Anthropic нет, так и говорит.
 */
export const platformManifestSchema = object({
  /** Инструменты клиента: полем (`native`) или текстом прослойки (`shim`). */
  clientTools: zodEnum(['native', 'shim']).optional(),
  /** Отправлять ли усилие рассуждения. */
  effort: boolean().optional(),
  /** Родная ручка Anthropic; пусто — мост в OpenAI. */
  anthropicMessages: string().refine(isManifestEndpointPath, 'путь ручки: `messages`').optional(),
  /** Ручка картинок OpenAI-вида; пусто — картинок у шлюза нет. */
  imagesApi: string().refine(isManifestEndpointPath, 'путь ручки: `images/generations`').optional(),
  /** Предел цельного ответа шлюза; 0 — не объявлен, действует потолок панели. */
  nonStreamTimeoutSec: number().int().min(0).max(PLATFORM_MANIFEST_TIMEOUT_MAX_SEC).optional(),
  /**
   * Потолок ЛЮБОГО ответа, потока тоже: шлюз или прокси перед ним рвёт соединение
   * по часам. 0 — не объявлен. Объявленный превращает безымянный обрыв в названный.
   */
  responseCeilingSec: number().int().min(0).max(PLATFORM_MANIFEST_TIMEOUT_MAX_SEC).optional(),
  /** Поле включения размышлений на проводе; пусто — правила размышлений нет. */
  thinkingField: string()
    .refine(isManifestWirePath, 'поле на проводе: `enable_thinking` или `a.b`')
    .optional(),
});

export type PlatformManifestOverrides = Infer<typeof platformManifestSchema>;

export type PlatformManifestField = keyof PlatformManifestOverrides;

export const platformManifestFields = Object.keys(
  platformManifestSchema.shape,
) as PlatformManifestField[];

/**
 * Переопределения из записи, пришедшей неизвестно откуда: старый `state.json`,
 * снимок чужой панели, правка файла руками. Поле за полем: негодное поле
 * отбрасывается и значит «как у пресета», а соседние остаются. Отказ целиком
 * запер бы весь раздел настроек из-за одной опечатки в пути.
 */
export function platformManifestOf(value: unknown): PlatformManifestOverrides {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const source = value as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const field of platformManifestFields) {
    const parsed = platformManifestSchema.shape[field].safeParse(source[field]);
    if (parsed.success && parsed.data !== undefined) out[field] = parsed.data;
  }
  return out as PlatformManifestOverrides;
}

/** Первое негодное поле переопределений — для отказа двери сохранения. */
export function platformManifestError(
  value: unknown,
): PlatformManifestField | 'manifest' | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== 'object' || Array.isArray(value)) return 'manifest';
  const source = value as Record<string, unknown>;
  return platformManifestFields.find(
    (field) => !platformManifestSchema.shape[field].safeParse(source[field]).success,
  );
}

export interface PlatformDriverPreset {
  base: PlatformDriverBase;
  /** Имя шлюза, одинаковое на любом языке. */
  title: string;
  /** Образец адреса: корень API, а не адрес админки. */
  sampleUrl: string;
  /** Заголовок ключа, если не `Authorization: Bearer` базы. */
  auth?: { header: string; scheme: string };
  /**
   * Умолчания нового контура (аудит DRV-20). Прослойка и короткий промпт
   * написаны ради моделей, не принимающих `tools` полем; шлюзу, который
   * принимает, прослойка стоит места в каждом запросе.
   */
  defaults: { toolShim: boolean; contourPrompt: boolean };
  manifest: PlatformManifestOverrides;
  /** Где сверены утверждения пресета. */
  source: string;
}

export const PLATFORM_PRESETS: Record<PlatformDriverId, PlatformDriverPreset> = {
  enterprise-platform: {
    base: 'enterprise-platform',
    title: 'EnterprisePlatform',
    sampleUrl: 'https://api.example.ru',
    defaults: { toolShim: true, contourPrompt: true },
    manifest: {},
    source: 'исходники контура: mod-llmbox chat/schemas.py, handler_public_api.go',
  },
  'openai-compat': {
    base: 'openai-compat',
    title: 'OpenAI-compatible',
    sampleUrl: 'https://gateway.example.com/v1',
    defaults: { toolShim: false, contourPrompt: false },
    manifest: {},
    source: 'схема OpenAI: /models, /chat/completions',
  },
  litellm: {
    base: 'openai-compat',
    title: 'LiteLLM',
    sampleUrl: 'http://127.0.0.1:4000',
    defaults: { toolShim: false, contourPrompt: false },
    manifest: { anthropicMessages: 'messages' },
    source: 'https://docs.litellm.ai/docs/anthropic_unified',
  },
  vllm: {
    base: 'openai-compat',
    title: 'vLLM',
    sampleUrl: 'http://127.0.0.1:8000/v1',
    defaults: { toolShim: false, contourPrompt: false },
    manifest: {
      anthropicMessages: 'messages',
      thinkingField: 'chat_template_kwargs.enable_thinking',
    },
    source:
      'https://docs.vllm.ai/en/stable/serving/integrations/claude_code/ · ' +
      'https://docs.vllm.ai/en/latest/features/reasoning_outputs/',
  },
  ollama: {
    base: 'openai-compat',
    title: 'Ollama',
    sampleUrl: 'http://127.0.0.1:11434/v1',
    defaults: { toolShim: false, contourPrompt: false },
    manifest: { anthropicMessages: 'messages' },
    source: 'https://docs.ollama.com/api/anthropic-compatibility',
  },
  openrouter: {
    base: 'openai-compat',
    title: 'OpenRouter',
    sampleUrl: 'https://openrouter.ai/api/v1',
    defaults: { toolShim: false, contourPrompt: false },
    manifest: { anthropicMessages: 'messages' },
    source: 'https://openrouter.ai/docs/cookbook/coding-agents/claude-code-integration',
  },
  'azure-openai': {
    base: 'openai-compat',
    title: 'Azure OpenAI',
    sampleUrl: 'https://example.openai.azure.com/openai/v1',
    auth: { header: 'api-key', scheme: '' },
    defaults: { toolShim: false, contourPrompt: false },
    manifest: {},
    source: 'https://learn.microsoft.com/en-us/azure/ai-foundry/openai/api-version-lifecycle',
  },
  dashscope: {
    base: 'openai-compat',
    title: 'DashScope',
    sampleUrl: 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1',
    defaults: { toolShim: false, contourPrompt: false },
    manifest: { thinkingField: 'enable_thinking' },
    source: 'https://www.alibabacloud.com/help/en/model-studio/deep-thinking',
  },
  together: {
    base: 'openai-compat',
    title: 'Together AI',
    sampleUrl: 'https://api.together.xyz/v1',
    defaults: { toolShim: false, contourPrompt: false },
    // Ручка картинок у Together есть, но форму байтов она просит словом
    // `base64`, а панель шлёт `b64_json` схемы OpenAI — объявить её значило бы
    // обещать дорогу, которая отвечает отказом.
    manifest: {},
    source: 'https://docs.together.ai/reference/post-images-generations',
  },
};

/**
 * Что объявлено в итоге — база, пресет и переопределения контура одним видом.
 * Нужно мастеру: «как у пресета» без самого значения человеку ничего не говорит.
 */
export interface PlatformManifestDeclared {
  clientTools: 'native' | 'shim';
  effort: boolean;
  /** Пусто — ручки нет, клиент Anthropic идёт мостом. */
  anthropicMessages: string;
  /** Пусто — отдельной ручки картинок нет. */
  imagesApi: string;
  /** Картинку рисует модель в ответе чата (дорога платформа компании). */
  imagesInChat: boolean;
  /** 0 — не объявлен. */
  nonStreamTimeoutSec: number;
  /** 0 — не объявлен. */
  responseCeilingSec: number;
  /** Пусто — правила размышлений нет. */
  thinkingField: string;
}

/**
 * Объявленное кодом базы. Сервер держит то же в манифестах драйверов, и набор
 * соответствия сверяет собранный драйвер с этой таблицей для КАЖДОГО пресета:
 * мастер, показавший «как у пресета» одно, а шлюз, пошедший по другому, — ровно
 * та ложь, от которой таблица и заведена.
 */
export const PLATFORM_DRIVER_BASES: Record<PlatformDriverBase, PlatformManifestDeclared> = {
  enterprise-platform: {
    clientTools: 'shim',
    effort: false,
    anthropicMessages: '',
    imagesApi: '',
    imagesInChat: true,
    nonStreamTimeoutSec: 120,
    responseCeilingSec: 120,
    thinkingField: 'chat_template_kwargs.enable_thinking',
  },
  'openai-compat': {
    clientTools: 'native',
    effort: false,
    anthropicMessages: '',
    imagesApi: '',
    imagesInChat: false,
    nonStreamTimeoutSec: 0,
    responseCeilingSec: 0,
    thinkingField: '',
  },
};

/** База ⊕ пресет ⊕ переопределения — тем же порядком, что и сборка драйвера на сервере. */
export function platformManifestDeclared(
  id: string,
  overrides?: PlatformManifestOverrides,
): PlatformManifestDeclared {
  const preset = platformPreset(id);
  const declared = { ...PLATFORM_DRIVER_BASES[preset.base] };
  for (const patch of [preset.manifest, platformManifestOf(overrides)]) {
    if (patch.clientTools) declared.clientTools = patch.clientTools;
    if (patch.effort !== undefined) declared.effort = patch.effort;
    if (patch.anthropicMessages !== undefined) declared.anthropicMessages = patch.anthropicMessages;
    if (patch.imagesApi !== undefined) {
      declared.imagesApi = patch.imagesApi;
      declared.imagesInChat = false;
    }
    if (patch.nonStreamTimeoutSec !== undefined) {
      declared.nonStreamTimeoutSec = patch.nonStreamTimeoutSec;
    }
    if (patch.responseCeilingSec !== undefined) {
      declared.responseCeilingSec = patch.responseCeilingSec;
    }
    if (patch.thinkingField !== undefined) declared.thinkingField = patch.thinkingField;
  }
  return declared;
}

/** Пресет по имени; незнакомое имя — совместимый шлюз, ничего не утверждающий. */
export function platformPreset(id: string): PlatformDriverPreset {
  return PLATFORM_PRESETS[id as PlatformDriverId] ?? PLATFORM_PRESETS['openai-compat'];
}

/**
 * Запись контура, где прослойки и промпта нет, — с умолчаниями пресета её типа.
 *
 * Не `default(true)` схемы: это умолчание платформа компании, и контур, сохранённый мимо
 * мастера (API, снимок, старая запись), получал прослойку на любом шлюзе — а
 * включённая прослойка перебивает родную ручку Anthropic, и пресет Ollama молча
 * уходил на мост (живой прогон DRV-03). Заполняется только отсутствующее:
 * сказанное явно не трогается, а негодное значение остаётся отказу схемы.
 */
export function withPresetDefaults<T>(value: T): T {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
  const record = value as Record<string, unknown>;
  if (record.toolShim !== undefined && record.contourPrompt !== undefined) return value;
  const { defaults } = platformPreset(String(record.driver));
  return {
    ...record,
    toolShim: record.toolShim ?? defaults.toolShim,
    contourPrompt: record.contourPrompt ?? defaults.contourPrompt,
  } as T;
}
