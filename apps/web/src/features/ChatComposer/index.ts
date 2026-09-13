export { ChatComposer } from './ui/ChatComposer';
// Предел размера вложения нужен и странице: она называет его в сообщении об отказе.
export { MAX_FILE_BYTES } from './lib/attachments';
/**
 * Само меню «Режим» — наружу, потому что композеров в панели ДВА: этот и свой у
 * чужого CLI (`pages/ProviderChat`). Режимы работают в обоих, и вторая копия меню
 * разошлась бы с первой на первой же правке — ровно как это было бы с карточкой
 * разделения задач.
 */
export { ChatModeMenu } from './ui/ChatModeMenu';
// Состояние меню «Режим» собирает страница: доступность считает сервер, а не композер.
export type { ComposerMode, ComposerModeState } from './ui/ChatComposer.types';
