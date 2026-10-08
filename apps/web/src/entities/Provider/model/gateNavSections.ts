import type { GatedNavItem, ProviderCapabilities } from './gating.types';
import type { NavSection } from '@shared/config/navigation';
import { navItemAccess } from './navItemAccess';

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
