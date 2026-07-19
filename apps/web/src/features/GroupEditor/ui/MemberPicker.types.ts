import type { EntityRef } from '@agentdeck/contracts';

export interface MemberPickerProps {
  value: EntityRef[];
  onChange: (members: EntityRef[]) => void;
}
