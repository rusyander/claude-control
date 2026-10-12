import type { PermissionGuardReason } from '@agentdeck/contracts';

export interface PendingPermission {
  toolName: string;
  input: unknown;
  toolUseId: string;
  guard?: PermissionGuardReason;
}

export interface PermissionCardProps {
  permissions: PendingPermission[];
  onDecide: (toolUseId: string, behavior: 'allow' | 'deny') => void;
}
