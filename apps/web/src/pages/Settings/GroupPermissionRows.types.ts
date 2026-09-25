import type { GroupPermissionLevel, GroupRequestId } from '@agentdeck/contracts/split-groups';
import type { GroupRow } from './model/groupRows';

export interface GroupPermissionRowsProps {
  rows: GroupRow[];
  /** Показывать ли метку «своё / как в общих» — только у проекта. */
  showOrigin?: boolean;
  disabled?: boolean;
  onChange: (id: GroupRequestId, level: GroupPermissionLevel) => void;
}
