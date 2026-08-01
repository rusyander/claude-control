/**
 * Разделы навигации переехали в общий реестр `@shared/config/navigation`: тот
 * же список читают командная палитра и горячие клавиши. Здесь оставлен реэкспорт,
 * чтобы боковая панель ссылалась на привычный путь.
 */
export { NAV_SECTIONS } from '@shared/config/navigation';
export type { NavItem, NavSection } from '@shared/config/navigation';

/**
 * Ширины держим числами: анимировать значение из CSS-переменной нельзя,
 * а раскладка на них и так завязана (см. --layout-sidebar-width).
 */
export const EXPANDED_WIDTH = 260;
export const COLLAPSED_WIDTH = 60;
