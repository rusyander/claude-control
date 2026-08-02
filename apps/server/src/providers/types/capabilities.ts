/**
 * Карта возможностей провайдера: какие разделы панели у него есть и в каком они
 * состоянии. Значения из этого модуля — единственное, что гейтит UI.
 */

/**
 * Набор возможностей и статусы берутся из общего словаря контрактов. Бочку
 * `@claude-control/contracts` сервер импортировать не может (её реэкспорты идут
 * без расширений, Node ESM их не резолвит), а вот отдельная точка экспорта
 * `@claude-control/contracts/vocabulary` — самодостаточный модуль без импортов,
 * и она резолвится. Так набор перестал быть двумя копиями, которые расходятся
 * молча: у каждой стороны свой тест, оба зелёные, а значения разные.
 */
import {
  CAPABILITIES,
  type Capability,
  type CapabilityStatus,
} from '@claude-control/contracts/vocabulary';

export {
  CAPABILITIES,
  type Capability,
  type CapabilityStatus,
  type ProviderStatus,
} from '@claude-control/contracts/vocabulary';

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
