import type { DeckAccent } from '@agentdeck/contracts';

/**
 * Цвета и метрики колоды — ОДНИМ списком на оба отрисовщика.
 *
 * Страница и файл PowerPoint собираются разными способами (CSS против OOXML), но
 * человек показывает одну и ту же колоду: сначала на экране, потом с флешки в
 * чужом кабинете. Разъехавшиеся палитры означали бы, что «синяя» презентация
 * приехала фиолетовой, и заметил бы это тот, кто уже стоит перед залом. Поэтому
 * шестнадцатеричные значения лежат здесь, а не по два раза в `html/` и `pptx/`.
 *
 * Значения — БЕЗ решётки: pptxgenjs принимает их именно так, а CSS решётку
 * дописывает сам (`hex()`).
 *
 * Контраст проверен по формуле WCAG: каждый акцент даёт не меньше 4.5 к белому
 * (мелкая подпись на светлом слайде), каждый «яркий» — не меньше 4.5 к своему
 * тёмному фону. Это не украшение: колоду смотрят с проектора, где половина
 * контраста теряется на стене.
 */

/** Палитра одного настроения. */
export interface DeckPalette {
  /** Акцент на светлом: линии, крупные числа, маркеры. */
  accent: string;
  /** Тот же акцент темнее — для текста поверх светлой подложки. */
  accentDeep: string;
  /** Акцент, который виден на тёмном слайде. */
  accentBright: string;
  /** Светлая подложка панели (колонка, врезка). */
  tint: string;
  /** Тёмный фон обложки и разделителя. */
  deep: string;
  /** Второй край градиента тёмного фона. */
  deepAlt: string;
}

/** Основной текст на светлом слайде. */
export const DECK_INK = '14171C';
/** Фон светлого слайда. Не чистый белый: на проекторе он «звенит». */
export const DECK_PAPER = 'FBFBFD';
/** Второстепенный текст: подписи, сноски, нижняя планка. */
export const DECK_MUTED = '5C6674';
/** Тонкая линия-разделитель. */
export const DECK_LINE = 'E3E6EC';
/** Текст на тёмном слайде. */
export const DECK_ON_DEEP = 'F5F6FA';
/** Второстепенный текст на тёмном слайде. */
export const DECK_ON_DEEP_MUTED = 'AEB4C6';

/** Шрифты только системные: страница не имеет права ходить в сеть. */
export const DECK_FONT_CSS =
  '"Segoe UI", system-ui, -apple-system, "Helvetica Neue", Arial, sans-serif';
/** В PPTX — шрифт, который есть на любой машине с PowerPoint. */
export const DECK_FONT_PPTX = 'Arial';

/** Слайд 16:9. В CSS-пикселях ровно 1280×720 — 96 пикселей на дюйм. */
export const DECK_W_IN = 13.333;
export const DECK_H_IN = 7.5;

const PALETTES: Record<DeckAccent, DeckPalette> = {
  indigo: {
    accent: '4F5BD5',
    accentDeep: '343C9B',
    accentBright: '93A0FF',
    tint: 'EEF0FC',
    deep: '141733',
    deepAlt: '2C2F7A',
  },
  teal: {
    accent: '0A7D75',
    accentDeep: '075751',
    accentBright: '55D6C8',
    tint: 'E6F4F2',
    deep: '082524',
    deepAlt: '0D5F5A',
  },
  amber: {
    accent: '9A6212',
    accentDeep: '6E450B',
    accentBright: 'F2B544',
    tint: 'FBF2E3',
    deep: '2A1E0E',
    deepAlt: '7A5316',
  },
  crimson: {
    accent: 'B02A41',
    accentDeep: '7C1B2C',
    accentBright: 'FF8A9B',
    tint: 'FCEEF0',
    deep: '2C0F16',
    deepAlt: '7A2030',
  },
  violet: {
    accent: '6D34AD',
    accentDeep: '4C2179',
    accentBright: 'C49BFF',
    tint: 'F4EDFD',
    deep: '1F1130',
    deepAlt: '55298A',
  },
  slate: {
    accent: '40536A',
    accentDeep: '2A3746',
    accentBright: 'A9BDD4',
    tint: 'EEF1F5',
    deep: '151B22',
    deepAlt: '33475C',
  },
};

/** Палитра колоды. Незнакомое или пустое настроение — `indigo`, как в контракте. */
export function deckPalette(accent: string | undefined): DeckPalette {
  return (accent && PALETTES[accent as DeckAccent]) || PALETTES.indigo;
}

/** Значение для CSS: там нужна решётка. */
export function hex(value: string): string {
  return `#${value}`;
}

/**
 * Смесь двух цветов долей `weight` от второго. Это ручной `color-mix` для
 * PowerPoint: полупрозрачного текста в OOXML нет, а призрачный номер раздела и
 * бледная кавычка должны выглядеть одинаково на странице и в файле.
 */
export function mix(from: string, to: string, weight: number): string {
  const part = Math.min(Math.max(weight, 0), 1);
  const channel = (at: number) => {
    const a = Number.parseInt(from.slice(at, at + 2), 16);
    const b = Number.parseInt(to.slice(at, at + 2), 16);
    return Math.round(a + (b - a) * part)
      .toString(16)
      .padStart(2, '0');
  };
  return `${channel(0)}${channel(2)}${channel(4)}`.toUpperCase();
}
