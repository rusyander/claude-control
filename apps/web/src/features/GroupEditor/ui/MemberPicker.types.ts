import type { EntityRef } from '@claude-control/contracts';

export interface MemberPickerProps {
  value: EntityRef[];
  onChange: (members: EntityRef[]) => void;
}
