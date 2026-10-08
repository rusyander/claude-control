import type { PanelPendingAction } from '@agentdeck/contracts/panel-agent';

/** Одобрить нельзя: предпросмотр неполный — сервер ответит 409. */
export function canApprove(pending: PanelPendingAction): boolean {
  return !pending.preview.truncated;
}
