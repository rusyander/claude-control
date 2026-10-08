import type { PlatformApplyTarget } from '@agentdeck/contracts';

export interface ApplyJournalProps {
  targets: PlatformApplyTarget[];
  onRollback: (targetId: string) => void;
  isPending: boolean;
}
