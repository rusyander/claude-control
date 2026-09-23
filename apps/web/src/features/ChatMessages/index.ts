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
/**
 * Карточка вложения из ответа агента (Т10) — и снова по той же причине: блоки
 * `agentdeck:{deck,svg}` приходят в обе ленты, а дорога агента и есть та,
 * которая работает у любого CLI.
 */
export { MediaFeedCard } from './ui/MediaFeedCard';
export type { MediaFeedCardProps } from './ui/MediaFeedCard.types';
export type { ChildPermission, ChildQuestion, HandoffControls } from './ui/ChatMessages.types';
/**
 * Сводка звеньев у родителя. Наружу выставлена по той же причине, что и
 * карточка разделения: хаб нужен ОБЕИМ лентам — у Claude его ставит `ChatMessages`,
 * у чужого провайдера страница его чата. Строки собирает страница: у Claude из
 * списка чатов и прогонов, у чужого CLI из дерева (`pages/ProviderChat/lib`).
 */
export { ChildStages } from './ui/ChildStages';
export type { ChildStageGroup, ChildStagesProps } from './ui/ChildStages.types';
/**
 * Склейка строк хаба с записью конвейера уровней. Наружу — по той же причине:
 * группу, у которой чата ещё нет, показывают обе ленты, а собрать её можно
 * только из записи конвейера, и второй копии этого счёта быть не должно.
 */
export { mergeSplitGroups, splitGroupKey } from './lib/mergeSplitGroups';
/**
 * Карточка решения по ревью чужого MR (Т7) и её сбор по дереву. Наружу — по той
 * же причине, что и хаб: лент ДВЕ, у Claude карточку ставит `ChatMessages`, у
 * чужого провайдера — страница его чата, а состояние у обеих одно, узел дерева.
 * Вторая копия сбора решала бы, кому какую карточку показывать, по-своему —
 * это либо чужое решение под рукой человека, либо своё, потерянное молча.
 */
export { ReviewDecisionCard } from './ui/ReviewDecisionCard';
export type { ReviewDecisionCardProps } from './ui/ReviewDecisionCard.types';
export type { ReviewDecisionItem } from './ui/ReviewDecisionCard.types';
export { collectReviews, reviewTreeOf } from './lib/reviewItems';
export { waitsDecision } from './lib/reviewWaiting';
