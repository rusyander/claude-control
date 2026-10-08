import type { ProviderInfo } from '@agentdeck/contracts';
import type { NavItem } from '@shared/config/navigation';

/** Карта возможностей активного провайдера или `undefined`, пока не загружено. */
export type ProviderCapabilities = ProviderInfo['capabilities'] | undefined;

/**
 * Гейтинг навигации по возможностям активного провайдера.
 *
 * Правило (см. план Ф2):
 * - раздел `ready` → показывается и работает;
 * - раздел `planned` → показывается с пометкой «в разработке», при заходе —
 *   плейсхолдер без чтения/записи (`inDevelopment`);
 * - раздел `unsupported` → скрыт из навигации (`hidden`);
 * - панель-level раздел (без привязки к возможности) виден всегда (`ready`).
 *
 * Пока данные о провайдерах не загружены, гейтинг оптимистичен: показываем всё
 * (дефолт — Claude, у которого доступно всё), чтобы навигация не мигала.
 */
export type SectionAccess = 'ready' | 'inDevelopment' | 'hidden';

/** Раздел навигации с рассчитанным доступом. */
export interface GatedNavItem extends NavItem {
  access: SectionAccess;
}
