/**
 * Разделы навигации переехали в общий реестр `@shared/config/navigation`: тот
 * же список читают командная палитра, подпись страницы в окне агента и справка.
 * Здесь — его срез для боковой панели.
 */
import { NAV_SECTIONS } from '@shared/config/navigation';
import type { NavSection } from '@shared/config/navigation';

export type { NavItem, NavSection } from '@shared/config/navigation';

/** Разделы без пунктов со своей строкой в панели (`inSidebar: false`). */
export const SIDEBAR_SECTIONS: NavSection[] = NAV_SECTIONS.map((section) => ({
  ...section,
  items: section.items.filter((item) => item.inSidebar !== false),
}));

/**
 * Ширины держим числами: анимировать значение из CSS-переменной нельзя,
 * а раскладка на них и так завязана (см. --layout-sidebar-width).
 */
export const EXPANDED_WIDTH = 260;
export const COLLAPSED_WIDTH = 60;
