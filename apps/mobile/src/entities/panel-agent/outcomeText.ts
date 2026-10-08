import type { PanelActionOutcome } from '@agentdeck/contracts/panel-agent';

export function outcomeText(
  outcome: PanelActionOutcome,
  texts: Record<PanelActionOutcome, string>,
): string {
  return texts[outcome] ?? outcome;
}
