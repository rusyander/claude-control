import type { MediaDeck } from '@agentdeck/contracts';

export interface MediaDeckCardProps {
  deck: MediaDeck;
  /** Кнопка закрытия — только в правом столбце: в ленте карточку не закрывают. */
  onClose?: () => void;
  /** Начать правку этой колоды: композер перейдёт в режим правки. */
  onRevise?: (deck: MediaDeck) => void;
}
