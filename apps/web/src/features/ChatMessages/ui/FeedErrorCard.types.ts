import type { StreamState } from '@entities/Chat';

export interface FeedErrorCardProps {
  /** Состояние потока: карточка рисуется, только когда в нём есть ошибка. */
  stream: StreamState;
  onRetry?: () => void;
  onContinue?: () => void;
  onDismissError?: () => void;
  /** Переполненный разговор: сжать контекст вместо «Повторить». */
  onCompact?: () => void;
  /** Переполненный разговор: уйти в свежую сессию. */
  onFreshSession?: () => void;
}
