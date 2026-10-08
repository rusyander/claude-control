import type { PanelPendingAction } from '@agentdeck/contracts/panel-agent';

export function withoutPending(
  list: PanelPendingAction[] | undefined,
  id: string,
): PanelPendingAction[] {
  return (list ?? []).filter((item) => item.id !== id);
}
