/**
 * Карта возможностей провайдера: какие разделы панели у него есть и в каком они
 * состоянии. Значения из этого модуля — единственное, что гейтит UI.
 */

/**
 * Почему union возможностей и статусов продублирован здесь значением, а не взят
 * из `@claude-control/contracts`: contracts тянется в сервер ТОЛЬКО как тип. Его
 * barrel реэкспортирует модули без расширений, а Node ESM в рантайме такие пути
 * не резолвит — импорт ЗНАЧЕНИЯ из contracts уронил бы сервер на старте
 * (`ERR_MODULE_NOT_FOUND`). Список обязан совпадать с contracts `CAPABILITIES`.
 */
export const CAPABILITIES = [
  'rules',
  'globalInstructions',
  'skills',
  'commands',
  'hooks',
  'scripts',
  'mcp',
  'permissions',
  'env',
  'plugins',
  'analytics',
  'projects',
  'chat',
  'sandbox',
] as const;

export type Capability = (typeof CAPABILITIES)[number];

/**
 * Статус возможности у провайдера. `ready` — работает сейчас; `planned` —
 * поддержим, адаптера ещё нет (раздел «в разработке», ничего не пишет);
 * `unsupported` — у этого CLI такого нет (раздел скрыт). См. contracts.
 */
export type CapabilityStatus = 'ready' | 'planned' | 'unsupported';

/** Насколько провайдер проверен: `verified` (Claude) или `experimental`. */
export type ProviderStatus = 'verified' | 'experimental';

/** Полная карта возможностей: статус по каждому ключу. */
export type CapabilityMap = Record<Capability, CapabilityStatus>;

/**
 * Собрать карту возможностей из частичного набора. Не перечисленные ключи
 * получают `unsupported` — fail-closed по умолчанию: незаявленную возможность
 * панель не показывает и не трогает.
 */
export function buildCapabilities(overrides: Partial<CapabilityMap>): CapabilityMap {
  const map = {} as CapabilityMap;
  for (const capability of CAPABILITIES) {
    map[capability] = overrides[capability] ?? 'unsupported';
  }
  return map;
}

/** Карта, где все возможности имеют один и тот же статус (для Claude — все `ready`). */
export function uniformCapabilities(status: CapabilityStatus): CapabilityMap {
  const map = {} as CapabilityMap;
  for (const capability of CAPABILITIES) map[capability] = status;
  return map;
}
