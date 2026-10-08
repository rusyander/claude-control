import type { PlatformRulesApplies } from '@agentdeck/contracts';

/** Какая сторона снята выбором: её колонка гаснет, значения остаются. */
export function sideOff(applies: PlatformRulesApplies): { contour: boolean; ours: boolean } {
  return { contour: applies === 'ours', ours: applies === 'contour' };
}
