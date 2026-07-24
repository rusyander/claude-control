import type {
  Capability,
  CapabilityStatus,
  ProviderInfo,
  ProvidersResponse,
} from '@claude-control/contracts';
import { NAV_CAPABILITIES, type NavItem, type NavSection } from '@shared/config/navigation';

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

/** Карта возможностей активного провайдера или `undefined`, пока не загружено. */
export type ProviderCapabilities = ProviderInfo['capabilities'] | undefined;

/** Активный провайдер из ответа эндпоинта. */
export function activeProvider(data: ProvidersResponse | undefined): ProviderInfo | undefined {
  if (!data) return undefined;
  return data.providers.find((provider) => provider.id === data.active);
}

/** Карта возможностей активного провайдера (или `undefined`, пока не загружено). */
export function activeCapabilities(data: ProvidersResponse | undefined): ProviderCapabilities {
  return activeProvider(data)?.capabilities;
}

/**
 * Готова ли возможность — для точечного гейта ЭЛЕМЕНТА внутри общей страницы
 * (кнопка песочницы на «Скриптах» и т.п.). Правила совпадают с `RouteGate`:
 * claude (в т.ч. пока настройки не пришли — это дефолт) → `true` без ожидания
 * карты; не-claude без карты → `false` (fail-closed).
 */
export function isCapabilityReady(
  providerId: string | undefined,
  data: ProvidersResponse | undefined,
  capability: Capability,
): boolean {
  if ((providerId ?? 'claude') === 'claude') return true;
  if (!data) return false;
  return activeProvider(data)?.capabilities[capability] === 'ready';
}

/** Доступ к разделу навигации у активного провайдера. */
export function navItemAccess(item: NavItem, capabilities: ProviderCapabilities): SectionAccess {
  // Панель-level раздел виден всегда, от провайдера не зависит.
  if (!item.capability) return 'ready';
  // Данные ещё не пришли — оптимистично считаем раздел доступным (дефолт Claude).
  if (!capabilities) return 'ready';
  const status: CapabilityStatus = capabilities[item.capability] ?? 'unsupported';
  if (status === 'ready') return 'ready';
  if (status === 'planned') return 'inDevelopment';
  return 'hidden';
}

/** Раздел навигации с рассчитанным доступом. */
export interface GatedNavItem extends NavItem {
  access: SectionAccess;
}

/** Секция навигации с гейтингом: скрытые разделы убраны, пустые секции — тоже. */
export interface GatedNavSection {
  label: string;
  items: GatedNavItem[];
}

/**
 * Прогнать секции навигации через гейтинг активного провайдера: разделы
 * `unsupported` убираются, `planned` помечаются, пустые секции отбрасываются.
 */
export function gateNavSections(
  sections: NavSection[],
  capabilities: ProviderCapabilities,
): GatedNavSection[] {
  return sections
    .map((section) => ({
      label: section.label,
      items: section.items
        .map((item): GatedNavItem => ({ ...item, access: navItemAccess(item, capabilities) }))
        .filter((item) => item.access !== 'hidden'),
    }))
    .filter((section) => section.items.length > 0);
}

/** Плоский список навигационных разделов, доступных к переходу (не скрытых). */
export function visibleNavItems(items: NavItem[], capabilities: ProviderCapabilities): NavItem[] {
  return items.filter((item) => navItemAccess(item, capabilities) !== 'hidden');
}

/** Сводка по возможностям: сколько разделов готово / в разработке / недоступно. */
export interface CapabilitySummary {
  ready: number;
  planned: number;
  unsupported: number;
}

/**
 * Пересчитать сводку по разделам, у которых есть навигация (`NAV_CAPABILITIES`),
 * — её показывает селектор провайдера как превью «сколько разделов доступно».
 */
export function summarizeNavCapabilities(
  capabilities: Record<Capability, CapabilityStatus>,
): CapabilitySummary {
  const summary: CapabilitySummary = { ready: 0, planned: 0, unsupported: 0 };
  for (const capability of NAV_CAPABILITIES) {
    const status = capabilities[capability] ?? 'unsupported';
    if (status === 'ready') summary.ready += 1;
    else if (status === 'planned') summary.planned += 1;
    else summary.unsupported += 1;
  }
  return summary;
}
