import type { PanelActionOutcome, PanelActionRisk } from '@agentdeck/contracts/panel-agent';
import type { BadgeTone } from '@shared/ui/badge';

export const OUTCOME_TONE: Partial<Record<PanelActionOutcome, BadgeTone>> = {
  done: 'success',
  failed: 'danger',
};

export const RISK_TONE: Record<PanelActionRisk, BadgeTone> = {
  read: 'neutral',
  change: 'warning',
  danger: 'danger',
};
