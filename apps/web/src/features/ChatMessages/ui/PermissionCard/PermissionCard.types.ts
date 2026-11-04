import type { PermissionGuardReason } from '@agentdeck/contracts';
import type { CorePermitAsk } from '@agentdeck/contracts/chat-handoff';

export interface PendingPermission {
  toolName: string;
  input: unknown;
  toolUseId: string;
  guard?: PermissionGuardReason;
  /** Вопрос права задачи ядра: решение шлёт окно командой ядра, а не маршрутом прогона. */
  core?: CorePermitAsk;
}

export interface PermissionCardProps {
  permissions: PendingPermission[];
  onDecide: (toolUseId: string, behavior: 'allow' | 'deny') => void;
}
