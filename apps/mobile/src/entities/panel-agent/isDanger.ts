import type { PanelPendingAction } from '@agentdeck/contracts/panel-agent';

/** Опасное действие: отказ — по умолчанию, «Выполнить» не первой кнопкой. */
export function isDanger(pending: PanelPendingAction): boolean {
  return pending.risk === 'danger';
}
