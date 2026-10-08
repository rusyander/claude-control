import type { KitItem } from '@agentdeck/contracts/kit';
import { VIEWS } from './KitItemEditor.constants';

export interface KitItemEditorProps {
  /** Открытый элемент; нет — окно закрыто. */
  item: KitItem | undefined;
  onClose: () => void;
}

export type View = (typeof VIEWS)[number];
