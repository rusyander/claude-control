import type { DeferredAskView } from '@agentdeck/contracts/deferred-asks';

export interface DeferredAskListProps {
  /** Записи, на которые можно ответить (`openAsks`): ждущие первыми. */
  items: DeferredAskView[];
  onDecide: (id: string, behavior: 'allow' | 'deny') => void;
  /** Запись, решение по которой сейчас уходит, — её кнопки заняты. */
  busyId?: string;
  /** Открыть разговор, где спросили. Нет — кнопки нет. */
  onOpenChat?: (chatId: string) => void;
  /** Фишки «чья запись» над списком — когда владельцев больше одного. */
  filterable?: boolean;
}

export interface DeferredAskRowProps {
  item: DeferredAskView;
  onDecide: DeferredAskListProps['onDecide'];
  isBusy: boolean;
  onOpenChat?: DeferredAskListProps['onOpenChat'];
}
