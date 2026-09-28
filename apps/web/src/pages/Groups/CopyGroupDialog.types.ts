import type { Group } from '@agentdeck/contracts';
import type { GroupListItem } from '@entities/Group';

export interface CopyGroupDialogProps {
  /** Что копируем. */
  group: GroupListItem;
  /** Имена всех групп — чтобы предложить свободное «(копия N)» и не дать занятое. */
  takenNames: readonly string[];
  onClose: () => void;
  /** Копия легла: страница открывает её окно. */
  onCopied: (copy: Group) => void;
}
