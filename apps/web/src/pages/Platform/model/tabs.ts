import type { PlatformStatus } from '@agentdeck/contracts';
import type { IconName } from '@shared/ui/icon';

/**
 * Вкладки раздела «Контур».
 *
 * Одна колонка из десятка карточек на каждый контур не просматривалась: правила
 * контура стояли на пятом экране под моделями, и человек их просто не находил.
 * Группы — по вопросу, который человек задаёт: «какие контуры есть», «какой
 * моделью отвечает», «какие правила действуют», «какие разделы через него
 * ходят», «что с инструментами и проверками», «какие агенты».
 *
 * `id` попадает в адрес (`/platform?tab=…`), порядок здесь — порядок на экране.
 */
export const PLATFORM_TABS = [
  { id: 'contours', icon: 'plug' },
  { id: 'model', icon: 'link' },
  { id: 'rules', icon: 'rules' },
  { id: 'access', icon: 'permissions' },
  { id: 'tools', icon: 'hooks' },
  { id: 'agents', icon: 'groups' },
] as const satisfies readonly { id: string; icon: IconName }[];

export type PlatformTabId = (typeof PLATFORM_TABS)[number]['id'];

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

export function platformTabDomId(id: PlatformTabId): string {
  return `platform-tab-${id}`;
}

export function platformPanelDomId(id: PlatformTabId): string {
  return `platform-panel-${id}`;
}

/**
 * Контур вкладки: названный в адресе, иначе первый в списке (активный стоит
 * первым). Удалённый или чужой идентификатор в адресе не даёт пустой вкладки.
 */
export function pickContour(
  platforms: readonly PlatformStatus[],
  id: string | undefined,
): PlatformStatus | undefined {
  return platforms.find((status) => status.platform.id === id) ?? platforms[0];
}
