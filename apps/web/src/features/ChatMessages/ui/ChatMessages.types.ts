import type { ChatMessage } from '@claude-control/contracts';
import type { StreamState } from '@entities/Chat';
import type { PendingPermission } from '@shared/lib/agent-runs';

export interface ChatMessagesProps {
  messages: ChatMessage[];
  /** Ответ, который набирается прямо сейчас. */
  stream: StreamState;
  isLoading: boolean;
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
}

export interface MessageBubbleProps {
  message: ChatMessage;
  onEdit: (text: string) => void;
  /** Ответить выбранным вариантом вопроса из истории. */
  onPickOption?: (answer: string) => void;
  /** Идёт прогон — варианты недоступны. */
  isRunning?: boolean;
}
