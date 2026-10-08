import type { SplitTaskOutcome } from '@agentdeck/contracts/chat-handoff';

export const OUTCOME_COLOR: Record<SplitTaskOutcome, 'success' | 'subtle' | 'warning' | 'danger'> =
  {
    moved: 'success',
    already: 'subtle',
    unavailable: 'warning',
    failed: 'danger',
    skipped: 'subtle',
  };
