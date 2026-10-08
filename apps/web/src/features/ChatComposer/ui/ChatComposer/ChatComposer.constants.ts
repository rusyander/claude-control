import type { ComposerMode } from './ChatComposer.types';

/** Значок кнопки отправки по режиму: действие видно не читая подписи. */
export const SEND_ICON: Record<ComposerMode, 'send' | 'image' | 'overview'> = {
  text: 'send',
  image: 'image',
  deck: 'overview',
};

/** Подсказка в пустом поле: в неттекстовом режиме там описывают, а не пишут. */
export const MEDIA_PLACEHOLDER: Partial<Record<ComposerMode, string>> = {
  image: 'chat.mode.imagePlaceholder',
  deck: 'chat.mode.deckPlaceholder',
};
