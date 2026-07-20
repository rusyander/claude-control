export interface PendingPermission {
  toolName: string;
  input: unknown;
  toolUseId: string;
}

export interface PermissionCardProps {
  permissions: PendingPermission[];
  onDecide: (toolUseId: string, behavior: 'allow' | 'deny') => void;
}
