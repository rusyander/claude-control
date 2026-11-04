import type { GroupListItem } from '@entities/Group';

export interface GroupTileProps {
  group: GroupListItem;
  /** Проектная сторона пары — тогда карточка одна на двоих. */
  pair?: GroupListItem;
  /** «В ядро» (этап 10, F1): «Путь» группы → сценарий ядра. */
  onCore?: (group: GroupListItem) => void;
}
