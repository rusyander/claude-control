import type { GroupListItem } from '@entities/Group';
import type { AdviceMode } from './AdviceModal.types';

export interface GroupDialogProps {
  group: GroupListItem;
  /** Проектная сторона пары — окно одно на двоих. */
  pair?: GroupListItem;
  /** Только что созданный сценарий: «Порядок работы» открыт на составлении первого шага. */
  startComposer?: boolean;
  onClose: () => void;
  onEdit: (group: GroupListItem) => void;
  onAdvice: (mode: AdviceMode, group: GroupListItem) => void;
  /** «Копировать группу»: независимая выключенная копия рядом. */
  onCopy: (group: GroupListItem) => void;
}
