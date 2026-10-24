import type { QwenAuthType, QwenProviderEntry, QwenProviderLookup } from './qwen.types.ts';

/**
 * Запись модели из `modelProviders` настроек Qwen Code — тем же выбором, что у CLI
 * (бандл 0.24.3: `resolveCliGenerationConfig`, `collectProviderModelsForProtocol`,
 * `resolveModelSelectionAuthType`, `resolveModelProtocol`). Зачем: окно записи
 * (`generationConfig.contextWindowSize`) главнее ключа верхнего уровня, а при записи
 * без окна Qwen ключ верхнего уровня вовсе не читает (предупреждает об этом и берёт
 * окно из своей таблицы). Живая проба 23.10.2026 (Stop-хук, `context_limit`): запись
 * с окном 123456 при верхнем 1 000 000 — 123456; запись без окна — 200 000 (таблица);
 * запись чужой модели — 1 000 000; флаг `--model` главнее `model.name`; свой id
 * поставщика работает только через `providerProtocol`; сохранённый `model.baseUrl`
 * выбирает запись; `modelProviders` старшего слоя заменяет младший целиком.
 */

/** Виды входа Qwen (`AuthType` бандла): только ими бывает протокол поставщика. */
const QWEN_AUTH_TYPES = new Set([
  'openai',
  'openai-responses',
  'qwen-oauth',
  'gemini',
  'vertex-ai',
  'anthropic',
]);
const OPENAI_FAMILY = new Set(['openai', 'openai-responses']);

type Entry = Record<string, unknown>;

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/** Протокол поставщика: явный `providerProtocol[id]`, иначе сам id, если он вид входа. */
function providerProtocolOf(providerId: string, map: Record<string, unknown>): string | undefined {
  const value = Object.hasOwn(map, providerId) ? map[providerId] : providerId;
  return typeof value === 'string' && QWEN_AUTH_TYPES.has(value) ? value : undefined;
}

/** Протокол записи: `wireApi` переводит OpenAI-совместимую запись между двумя API. */
function entryProtocol(
  providerId: string,
  entry: Entry,
  map: Record<string, unknown>,
): string | undefined {
  const protocol = providerProtocolOf(providerId, map);
  if (!protocol || entry.wireApi === undefined) return protocol;
  // Негодный `wireApi` CLI не принимает — такая запись не выбирается.
  if (entry.wireApi !== 'chat-completions' && entry.wireApi !== 'responses') return undefined;
  if (!OPENAI_FAMILY.has(protocol)) return undefined;
  return entry.wireApi === 'responses' ? 'openai-responses' : 'openai';
}

function allEntries(modelProviders: unknown): [string, Entry][] {
  const out: [string, Entry][] = [];
  for (const [providerId, models] of Object.entries(record(modelProviders))) {
    if (!Array.isArray(models)) continue;
    for (const model of models) {
      if (model && typeof model === 'object') out.push([providerId, model as Entry]);
    }
  }
  return out;
}

/** Вид входа после выбора модели: у OpenAI-совместимых запись может сменить API. */
function selectionAuth(
  auth: QwenAuthType,
  model: string,
  entries: [string, Entry][],
  map: Record<string, unknown>,
  baseUrl: string | undefined,
): QwenAuthType {
  if (!OPENAI_FAMILY.has(auth)) return auth;
  const candidates: { entry: Entry; auth: string }[] = [];
  for (const [providerId, entry] of entries) {
    const protocol = entryProtocol(providerId, entry, map);
    if (entry.id !== model || !protocol) continue;
    const switchable =
      (entry.wireApi !== undefined || providerProtocolOf(providerId, map) === 'openai-responses') &&
      OPENAI_FAMILY.has(protocol);
    if (protocol === auth || switchable) candidates.push({ entry, auth: protocol });
  }
  const preferred = (list: typeof candidates) => list.find((one) => one.auth === auth) ?? list[0];
  const exact =
    baseUrl === undefined
      ? undefined
      : preferred(candidates.filter((one) => (one.entry.baseUrl || null) === (baseUrl || null)));
  return (exact ?? preferred(candidates))?.auth ?? auth;
}

/** Запись модели хода, которую применит Qwen; нет — `undefined` (действует верхний ключ). */
export function qwenProviderEntry(lookup: QwenProviderLookup): QwenProviderEntry | undefined {
  const { auth, model, persistedBaseUrl } = lookup;
  if (!auth || !model) return undefined;
  const map = record(lookup.providerProtocol);
  const entries = allEntries(lookup.modelProviders);
  const finalAuth = selectionAuth(auth, model, entries, map, persistedBaseUrl);
  const ofModel = entries
    .filter(([providerId, entry]) => entryProtocol(providerId, entry, map) === finalAuth)
    .map(([, entry]) => entry)
    .filter((entry) => entry.id === model);
  const entry =
    (persistedBaseUrl ? ofModel.find((one) => one.baseUrl === persistedBaseUrl) : undefined) ??
    ofModel[0];
  if (!entry) return undefined;
  const config = record(entry.generationConfig);
  return {
    window: config.contextWindowSize,
    hasWindow: 'contextWindowSize' in config,
    ...(typeof entry.baseUrl === 'string' && entry.baseUrl ? { baseUrl: entry.baseUrl } : {}),
  };
}
