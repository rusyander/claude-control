import type { KitItem } from '@agentdeck/contracts/kit';

export interface KitItemRowProps {
  item: KitItem;
  /** Глобальный слой Claude Code — для сверки и переноса. */
  globalDir: string;
  onOpen: (item: KitItem) => void;
  onImprove: (item: KitItem) => void;
}
