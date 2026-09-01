export { ChatMessages } from './ui/ChatMessages';
/**
 * Карточка предложения разделить задачи. Наружу выставлена потому, что лент
 * переписки в панели ДВЕ — своя у Claude и своя у чужого провайдера, — а
 * предложение приходит одинаковым блоком в обеих. Вторая копия карточки
 * разошлась бы с первой на первой же правке формата.
 */
export { TaskSplitCard } from './ui/TaskSplitCard';
export type { TaskSplitCardProps } from './ui/TaskSplitCard.types';
/** Карточка продолжения в чистой сессии — по той же причине, что и соседняя. */
export { HandoffCard } from './ui/HandoffCard';
export type { HandoffCardProps } from './ui/HandoffCard.types';
export type { HandoffControls } from './ui/ChatMessages.types';
