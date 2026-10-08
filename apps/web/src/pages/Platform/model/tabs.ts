import { PLATFORM_TABS } from './tabs.constants';
import type { PlatformTabId } from './tabs.types';

export const DEFAULT_PLATFORM_TAB: PlatformTabId = 'contours';

/**
 * Вкладки, у которых содержимое относится к ОДНОМУ контуру: над ними стоит
 * выбор контура, а выбранный живёт в `?id=`. Агентов здесь нет: они есть только
 * у включённого контура, а включённый ровно один.
 */
export const PER_CONTOUR_TABS: readonly PlatformTabId[] = ['model', 'rules', 'access'];

/**
 * Вкладка из адреса. Незнакомое значение — первая вкладка, а не пустой экран:
 * адрес мог устареть. `key` (ссылка агента панели на шаг ключа) сюда тоже
 * попадает и открывает список контуров — мастер поверх него открывает страница.
 */
export function findPlatformTab(id: string | undefined): PlatformTabId {
  const found = PLATFORM_TABS.find((tab) => tab.id === id);
  return found ? found.id : DEFAULT_PLATFORM_TAB;
}
