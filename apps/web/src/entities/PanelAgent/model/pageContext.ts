import { NAV_SECTIONS } from '@shared/config/navigation';

/**
 * Ключ подписи раздела по адресу. Совпадение по самому длинному префиксу:
 * `/tests/…` — это «Тестирование», а корень `/` подходит только сам себе,
 * иначе любая страница читалась бы «Обзором».
 */
export function sectionLabelKey(pathname: string): string | undefined {
  let best: { path: string; label: string } | undefined;
  for (const section of NAV_SECTIONS) {
    for (const item of section.items) {
      const fits =
        item.path === '/'
          ? pathname === '/'
          : pathname === item.path || pathname.startsWith(`${item.path}/`);
      if (fits && (!best || item.path.length > best.path.length)) best = item;
    }
  }
  return best?.label;
}
