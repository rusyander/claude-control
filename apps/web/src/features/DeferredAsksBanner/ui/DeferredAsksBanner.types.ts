import type { DeferredAskView } from '@entities/DeferredAsk';

export interface DeferredAsksBannerViewProps {
  /** Весь список сервера: плашка сама считает ждущие и берёт открытые. */
  items: DeferredAskView[];
  onDecide: (id: string, behavior: 'allow' | 'deny') => void;
  busyId?: string;
  onOpenChat?: (chatId: string) => void;
  /** Список раскрыт сразу (тесты и съёмка). */
  defaultOpen?: boolean;
}
