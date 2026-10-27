import type { TurnTrail } from '../../lib/turnTrail.types';

export interface TurnTrailProps {
  /** След хода; нет — ходу нечего показать, строки нет. */
  trail: TurnTrail | undefined;
}
