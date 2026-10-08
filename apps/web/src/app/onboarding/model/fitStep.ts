import type { Step } from '../OnboardingWizard.types';

/** Шаг, которого в списке нет (сохранён до смены провайдера), — последний из оставшихся. */
export function fitStep(step: Step, order: readonly Step[]): Step {
  return order.includes(step) ? step : (order[order.length - 1] ?? step);
}
