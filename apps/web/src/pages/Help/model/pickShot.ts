import type { ShotVariantIndex, ShotTheme, ShotLang, PickedShot } from './shotVariant.types';
import { shotFallbackChain } from './shotVariant';

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
