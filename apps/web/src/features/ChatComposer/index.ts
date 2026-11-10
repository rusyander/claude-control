export { ChatComposer } from './ui/ChatComposer/ChatComposer';
// Предел размера вложения нужен и странице: она называет его в сообщении об отказе.
export { MAX_FILE_BYTES } from './lib/attachments';
// Состав отказа при вложении: страница превращает его в сообщение.
export type { AttachRejection } from './ui/ChatComposer/ChatComposer.types';
// Состояние меню «Режим» собирает страница: доступность считает сервер, а не композер.
export type { ComposerMode, ComposerModeState } from './ui/ChatComposer/ChatComposer.types';
// Чипы описаний (выбранный элемент сайта): кладёт страница, показывает поле, блоки — в сообщение.
export { composerChips, withChipBlocks, COMPOSER_CHIPS_MAX } from './model/composerChips';
export type { ComposerChip } from './model/composerChips.types';
