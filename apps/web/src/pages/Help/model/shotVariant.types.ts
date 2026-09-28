/** Тема панели, в которой снят кадр. */
export type ShotTheme = 'light' | 'dark';

/** Язык интерфейса на кадре. */
export type ShotLang = 'ru' | 'en';

/** Вариант кадра: тема × язык, `light-ru` — исходный. */
export type ShotVariantKey = `${ShotTheme}-${ShotLang}`;

/** Один снятый вариант: файл рядом с остальными и его размер в пикселях. */
export interface ShotVariantFile {
  file: string;
  width: number;
  height: number;
}

/** Какие варианты кадра сняты. Нет ключа — варианта нет на диске. */
export type ShotVariants = Partial<Record<ShotVariantKey, ShotVariantFile>>;

/**
 * Опись вариантов раздела: `apps/web/public/help/<раздел>/variants.json`.
 * Пишет её съёмка (`tools/help-shots/kit.mjs`), сверяет `check-help-shots.mjs`.
 * Ключ кадра — `<сценарий>/<кадр>`.
 */
export interface ShotVariantIndex {
  topic: string;
  frames: Record<string, ShotVariants>;
}

/** Что показать: адрес картинки и, если известен, её размер. */
export interface PickedShot {
  src: string;
  variant: ShotVariantKey;
  width?: number;
  height?: number;
}
