import type { LimitFact } from '@agentdeck/contracts/core/economy';

/** Окно маршрута для `/v1/health` (07): вердикт на вид предела, сброс, причины. */
export interface WindowHealthRow {
  routeId: string;
  limitKind: LimitFact['limitKind'];
  verdict: string;
  resumeAt: number | null;
  usedPct: number | null;
  observedAt: number;
}
