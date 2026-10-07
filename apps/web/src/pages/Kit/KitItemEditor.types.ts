import type { KitItem } from '@agentdeck/contracts/kit';

export interface KitItemEditorProps {
  /** Открытый элемент; нет — окно закрыто. */
  item: KitItem | undefined;
  onClose: () => void;
}
