import type { ChatMessage } from '@claude-control/contracts';
import type { TaskSplitProposal } from '@claude-control/contracts/task-split';
import type { HandoffProposal } from '@claude-control/contracts/chat-handoff';
import type { StreamState } from '@entities/Chat';
import type { PendingPermission } from '@shared/lib/agent-runs';

/**
 * Всё, что карточке продолжения нужно от страницы, одним объектом. Плоскими
 * свойствами это было бы шесть штук на двух компонентах сразу — а живут они
 * только вместе: без тумблера и номера шага карточка не показывает, во что
 * человек соглашается.
 */
export interface HandoffControls {
  /** Продолжить в чистой сессии. */
  onContinue: (proposal: HandoffProposal, options: { startRun: boolean }) => void;
  /** Остаться в этом разговоре — отказ уходит агенту репликой. */
  onKeepHere: () => void;
  /** Тумблер «дальше продолжай сам» этого разговора. */
  auto: boolean;
  onAutoChange: (auto: boolean) => void;
  /** Какой это шаг цепочки и где потолок. */
  chainDepth: number;
  maxChain: number;
  /** Новый разговор заводится прямо сейчас. */
  isPending: boolean;
}

export interface ChatMessagesProps {
  messages: ChatMessage[];
  /**
   * Идентификатор разговора. По его смене лента прокручивается к последнему
   * сообщению; при подгрузке более ранних он не меняется, поэтому позиция
   * прокрутки сохраняется.
   */
  conversationId?: string;
  /** Ответ, который набирается прямо сейчас. */
  stream: StreamState;
  isLoading: boolean;
  /** Есть ли более ранние сообщения до начала ленты — показывать «Загрузить ещё». */
  hasMore?: boolean;
  /** Идёт подгрузка более ранних сообщений. */
  isLoadingMore?: boolean;
  /** Подгрузить более ранние сообщения (кнопка вверху ленты). */
  onLoadMore?: () => void;
  /** Повторить свой запрос, отредактировав его текст. */
  onEdit: (text: string) => void;
  /** Ответить выбранным вариантом вопроса (отправка в тот же разговор). */
  onPickOption?: (answer: string) => void;
  /** Идёт прогон — варианты вопроса недоступны, пока агент занят. */
  isRunning?: boolean;
  /** Запросы прав, ждущие решения человека (карточка «Разрешить/Запретить»). */
  permissions?: PendingPermission[];
  /** Решение по запросу прав. */
  onPermissionDecide?: (toolUseId: string, behavior: 'allow' | 'deny') => void;
  /** Повторить упавший запрос — кнопка прямо в карточке ошибки. */
  onRetry?: () => void;
  /** Единицы расхода из настроек: объём в токенах или деньги. */
  costUnit?: 'tokens' | 'money';
  /** Глубина продумывания текущего прогона — идёт в разбивку расхода. */
  effort?: string;
  /** Согласиться на разделение задач по чатам (карточка в ответе агента). */
  onSplit?: (proposal: TaskSplitProposal, options: { startRuns: boolean }) => void;
  /** Отказаться от разделения — продолжаем в этом же разговоре. */
  onKeepHere?: () => void;
  /** Копии заводятся прямо сейчас: кнопка карточки показывает ожидание. */
  isSplitPending?: boolean;
  /** Продолжение в чистой сессии (карточка в ответе агента). */
  handoff?: HandoffControls;
}

export interface MessageBubbleProps {
  message: ChatMessage;
  onEdit: (text: string) => void;
  /** Ответить выбранным вариантом вопроса из истории. */
  onPickOption?: (answer: string) => void;
  /**
   * Это последнее сообщение ленты, то есть вопрос в нём ещё ждёт ответа.
   * У всех остальных карточка только для чтения: ответить на вопрос,
   * заданный десять ходов назад, значит отправить агенту реплику без
   * всякого повода — а промахнуться по ней при прокрутке легко.
   */
  isLast?: boolean;
  /** Идёт прогон — варианты недоступны. */
  isRunning?: boolean;
  /** Единицы расхода из настроек: объём в токенах или деньги. */
  costUnit?: 'tokens' | 'money';
  /** Согласиться на разделение задач по чатам (карточка вместо блока в тексте). */
  onSplit?: (proposal: TaskSplitProposal, options: { startRuns: boolean }) => void;
  /** Отказаться от разделения — продолжаем в этом же разговоре. */
  onKeepHere?: () => void;
  /** Копии заводятся прямо сейчас. */
  isSplitPending?: boolean;
  /** Продолжение в чистой сессии (карточка вместо блока в тексте). */
  handoff?: HandoffControls;
}
