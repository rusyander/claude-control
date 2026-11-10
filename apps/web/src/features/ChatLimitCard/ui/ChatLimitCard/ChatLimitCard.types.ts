import type { StreamState } from '@shared/lib/chat-stream';

export interface ChatLimitCardProps {
  /** Поток хода: флаг отказа окна, ошибка и время сброса из события окна. */
  stream: Pick<StreamState, 'limitHit' | 'error' | 'limitResetsAt'>;
  /** Задача ядра чата (`coreTask` прогона): её вид даёт варианты перевода и точный сброс. */
  coreTaskId?: string;
  /** Разговор этой страницы: его ищет перенос в плане к новому CLI. */
  conversationId?: string;
}
