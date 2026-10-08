import type { KitItem } from '@agentdeck/contracts/kit';

export interface KitGlobalActionsProps {
  item: KitItem;
  /** Глобальный слой Claude Code — путь в подтверждении, когда двойника ещё нет. */
  globalDir: string;
}
