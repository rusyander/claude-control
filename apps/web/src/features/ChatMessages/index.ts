export { ChatMessages } from './ui/ChatMessages/ChatMessages';
export { QueuedBubbles } from './ui/QueuedBubbles/QueuedBubbles';
/**
 * Окно ленты при возврате в разговор. Наружу — потому что размер окна держит
 * страница («Загрузить ещё»), а место в ленте помнит эта фича: вернуть человека
 * к ранней части длинного разговора можно, только вернув и окно, где она есть.
 */
export { recallFeedLimit, rememberFeedLimit } from './lib/feedPosition';
/**
 * Карточка предложения разделить задачи. Наружу выставлена потому, что лент
 * переписки в панели ДВЕ — своя у Claude и своя у чужого провайдера, — а
 * предложение приходит одинаковым блоком в обеих. Вторая копия карточки
 * разошлась бы с первой на первой же правке формата.
 */
export { TaskSplitCard } from './ui/TaskSplitCard/TaskSplitCard';
export type { TaskSplitCardProps } from './ui/TaskSplitCard.types';
/**
 * Карточка просьбы о разрешении — по той же причине: у чужого CLI просьбы идут
 * из его серверного режима, а решает их человек той же карточкой, что у Claude.
 */
export { PermissionCard } from './ui/PermissionCard/PermissionCard';
export type { PendingPermission } from './ui/PermissionCard/PermissionCard.types';
/** Карточка продолжения в чистой сессии — по той же причине, что и соседняя. */
export { HandoffCard } from './ui/HandoffCard/HandoffCard';
export type { HandoffCardProps } from './ui/HandoffCard/HandoffCard.types';
/**
 * Карточка вложения из ответа агента (Т10) — и снова по той же причине: блоки
 * `agentdeck:{deck,svg}` приходят в обе ленты, а дорога агента и есть та,
 * которая работает у любого CLI.
 */
export { MediaFeedCard } from './ui/MediaFeedCard/MediaFeedCard';
export { MediaRequestText } from './ui/MediaRequestText/MediaRequestText';
export type { MediaFeedCardProps } from './ui/MediaFeedCard/MediaFeedCard.types';
export type { ChildPermission, ChildQuestion, HandoffControls } from './ui/ChatMessages.types';
/**
 * Сводка звеньев у родителя. Наружу выставлена по той же причине, что и
 * карточка разделения: хаб нужен ОБЕИМ лентам — у Claude его ставит `ChatMessages`,
 * у чужого провайдера страница его чата. Строки собирает страница: у Claude из
 * списка чатов и прогонов, у чужого CLI из дерева (`pages/ProviderChat/lib`).
 */
export { ChildStages } from './ui/ChildStages/ChildStages';
/**
 * Вопросы и запросы прав звеньев у родителя. Собирает их страница
 * (`pages/Chat/lib/treeAsks`), рисует этот блок — и её тест сверяет сборку с
 * настоящей отрисовкой, а не с копией разметки.
 */
export { ChildBlocks } from './ui/ChildBlocks/ChildBlocks';
export type { ChildStageGroup, ChildStagesProps } from './ui/ChildStages.types';
export { splitGroupKey } from './lib/splitGroupKey';
