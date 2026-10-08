import type { KitGlobalItem } from '@agentdeck/contracts/kit';

export interface KitGlobalOnlyProps {
  /** Элементы глобального слоя того же вида, что открытая вкладка. */
  items: KitGlobalItem[];
}
