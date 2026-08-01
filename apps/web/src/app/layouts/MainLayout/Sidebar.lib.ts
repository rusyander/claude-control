import type { GatedNavItem } from '@entities/Provider';

/**
 * Подсказка браузера для пункта меню. В свёрнутой панели подписи не видно —
 * её заменяет title, а раздел в разработке дописывает к нему пометку. В
 * развёрнутой подпись видна сама, поэтому подсказки нет вовсе.
 */
export function navItemTitle(
  item: GatedNavItem,
  isCollapsed: boolean,
  t: (key: string) => string,
): string | undefined {
  if (!isCollapsed) return undefined;
  if (item.access === 'inDevelopment') return `${t(item.label)} — ${t('providers.inDevelopment')}`;
  return t(item.label);
}
