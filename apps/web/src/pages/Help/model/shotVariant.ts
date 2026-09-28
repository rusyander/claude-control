import type {
  PickedShot,
  ShotLang,
  ShotTheme,
  ShotVariantIndex,
  ShotVariantKey,
} from './shotVariant.types';

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

/** Язык панели → язык кадра: всё, что не английский, снято по-русски. */
export function shotLangOf(language: string): ShotLang {
  return language.startsWith('en') ? 'en' : 'ru';
}

/**
 * Какой файл показать.
 *
 * Выбор идёт по ОПИСИ вариантов, а не пробой адресов: проба означала бы
 * 404 и битую картинку на миг между попытками — страница прыгала бы при каждой
 * смене темы. Опись же знает и размер кадра: `width`/`height` на `<img>`
 * резервируют место до загрузки.
 *
 * Описи нет (раздел ещё не снимался по-новому) или кадра в ней нет — берётся
 * исходный светлый русский файл без размера: так справка показывала кадры до
 * вариантов, и хуже, чем было, не станет.
 */
export function pickShot(
  index: ShotVariantIndex | undefined,
  where: { topic: string; scenario: string; frame: string },
  theme: ShotTheme,
  lang: ShotLang,
): PickedShot {
  const base = `/help/${where.topic}/${where.scenario}`;
  const variants = index?.frames[`${where.scenario}/${where.frame}`];
  if (variants) {
    for (const key of shotFallbackChain(theme, lang)) {
      const found = variants[key];
      if (found) {
        return {
          src: `${base}/${found.file}`,
          variant: key,
          width: found.width,
          height: found.height,
        };
      }
    }
  }
  return { src: `${base}/${where.frame}.png`, variant: 'light-ru' };
}
