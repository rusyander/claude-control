import type { GroupListItem } from '@entities/Group';

export interface GroupTileProps {
  group: GroupListItem;
  /** Проектная сторона пары — тогда карточка одна на двоих. */
  pair?: GroupListItem;
  onOpen: () => void;
  /** «Копировать группу» — окно подтверждения с именем копии. */
  onCopy: () => void;
}
