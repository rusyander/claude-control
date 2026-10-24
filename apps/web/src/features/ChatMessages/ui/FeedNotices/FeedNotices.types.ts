import type { StreamState } from '@entities/Chat';

export interface FeedNoticesProps {
  /** Состояние потока: строка показывается вместо пузыря, а не рядом с ним. */
  stream: StreamState;
  /** Перечитать переписку — предлагается только при потерянной связи. */
  onRefresh?: () => void;
  /** Вернуть ход в остывшую сессию — только под заметкой о новом разговоре, пока он идёт (R5). */
  onKeepSession?: () => void;
}
