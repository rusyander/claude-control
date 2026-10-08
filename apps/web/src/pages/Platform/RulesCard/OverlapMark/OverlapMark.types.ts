import type { PlatformRuleConflict } from '@agentdeck/contracts';

export interface OverlapMarkProps {
  /** Ячейка матрицы, которой касается строка; нет — строка ни с чем не пересекается. */
  cell: PlatformRuleConflict | undefined;
  /** С чем пересекается — правило ДРУГОЙ стороны, словами. */
  what: string;
}
