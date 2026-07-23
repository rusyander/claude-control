/**
 * Разделы навигации переехали в общий реестр `@shared/config/navigation`: тот
 * же список читают командная палитра и горячие клавиши. Здесь оставлен реэкспорт,
 * чтобы боковая панель ссылалась на привычный путь.
 */
export { NAV_SECTIONS } from '@shared/config/navigation';
export type { NavItem, NavSection } from '@shared/config/navigation';
