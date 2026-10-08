import type { ShotLang, ShotTheme, ShotVariantKey } from './shotVariant.types';

/**
 * Порядок поиска кадра под тему и язык панели.
 *
 * 1. Точное совпадение: тёмная тема и английский — тёмный английский кадр.
 * 2. Та же тема, другой язык: на тёмной теме светлый прямоугольник режет глаз
 *    сильнее, чем подписи на соседнем языке, — тема важнее языка.
 * 3. Светлый кадр того же языка.
 * 4. Светлый русский — он есть у каждого кадра, с него съёмка начинается.
 *
 * Повторы (для `light-*` шаги 1 и 3 совпадают) убираются, порядок остаётся.
 */
export function shotFallbackChain(theme: ShotTheme, lang: ShotLang): ShotVariantKey[] {
  const other: ShotLang = lang === 'en' ? 'ru' : 'en';
  const chain: ShotVariantKey[] = [
    `${theme}-${lang}`,
    `${theme}-${other}`,
    `light-${lang}`,
    'light-ru',
  ];
  return [...new Set(chain)];
}
