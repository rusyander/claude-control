import type { ChatMessage } from '@claude-control/contracts';
import type { StreamState } from '@entities/Chat';
import type { PendingPermission } from '@shared/lib/agent-runs';

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
}

export interface MessageBubbleProps {
  message: ChatMessage;
  onEdit: (text: string) => void;
  /** Ответить выбранным вариантом вопроса из истории. */
  onPickOption?: (answer: string) => void;
  /** Идёт прогон — варианты недоступны. */
  isRunning?: boolean;
  /** Единицы расхода из настроек: объём в токенах или деньги. */
  costUnit?: 'tokens' | 'money';
}
