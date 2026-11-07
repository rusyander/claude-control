export { ChatMessages } from './ui/ChatMessages/ChatMessages';
export { QueuedBubbles } from './ui/QueuedBubbles/QueuedBubbles';
/**
 * Окно ленты при возврате в разговор. Наружу — потому что размер окна держит
 * страница («Загрузить ещё»), а место в ленте помнит эта фича: вернуть человека
 * к ранней части длинного разговора можно, только вернув и окно, где она есть.
 */
export { recallFeedLimit, rememberFeedLimit } from './lib/feedPosition';
/** Просьба о разрешении: её состав собирает страница из потока хода. */
export type { PendingPermission } from './ui/PermissionCard/PermissionCard.types';
export type { ChildPermission, ChildQuestion, HandoffControls } from './ui/ChatMessages.types';
/**
 * Сводка звеньев у родителя: хаб ставит `ChatMessages`, а строки собирает страница из списка
 * чатов и прогонов. Карточки лент (разделение, продолжение, вложение, разрешение) наружу больше
 * не выставлены: вторая лента чужого CLI (`pages/ProviderChat`) снята с единым чатом (этап 11).
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
