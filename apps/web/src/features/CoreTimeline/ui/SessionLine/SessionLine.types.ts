import type { SessionView } from '@agentdeck/contracts/core/task-view';
import type { SpendPart } from '../../model/items';

export interface SessionLineProps {
  session: SessionView;
  spend: SpendPart | null;
}
