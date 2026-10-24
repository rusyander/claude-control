import type { PermissionGuardReason } from '@agentdeck/contracts';

export interface PendingPermission {
  toolName: string;
  input: unknown;
  toolUseId: string;
  guard?: PermissionGuardReason;
  /** Карточка отложена как D-n: агент работает дальше, кнопки решают запись. */
  deferredId?: string;
}

export interface DeferredPermissionCardProps {
  /** Отложенные карточки разговора — у каждой свой `deferredId`. */
  permissions: PendingPermission[];
  onDecide: (toolUseId: string, behavior: 'allow' | 'deny') => void;
}

export interface PermissionCardProps {
  permissions: PendingPermission[];
  onDecide: (toolUseId: string, behavior: 'allow' | 'deny') => void;
}
