import type { ProjectTestReleaseRequirement } from '@agentdeck/contracts';

/** Цвет состояния требования: «не до конца» — предупреждение, остальное красное. */
export const STATE_TONE: Record<
  ProjectTestReleaseRequirement['state'],
  'success' | 'warning' | 'danger'
> = {
  covered: 'success',
  partial: 'warning',
  red: 'danger',
  uncovered: 'danger',
};
