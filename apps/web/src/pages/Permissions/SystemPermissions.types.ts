import type { PermissionRule } from '@agentdeck/contracts';

export interface SystemPermissionsProps {
  rules: PermissionRule[];
  onEdit: (rule: PermissionRule) => void;
  /** Создать правило для действия, которое ещё не настроено. */
  onCreate: (pattern: string) => void;
}
