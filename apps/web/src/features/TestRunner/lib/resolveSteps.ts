import type { ProjectTestStep, ProjectTestSharedStep } from '@agentdeck/contracts';
import { expandSteps, applyParams } from '@agentdeck/contracts/test-format';

/**
 * Шаги поинта в том виде, в каком их читает человек: общие раскрыты, значения
 * параметров подставлены. Отдельной функцией — по ней и проверяется, что
 * тестировщик и агент видят один и тот же текст.
 */
export function resolveSteps(
  steps: ProjectTestStep[] | undefined,
  sharedSteps: ProjectTestSharedStep[],
  params: Record<string, string> = {},
): ProjectTestStep[] {
  if (!steps) return [];
  return expandSteps(steps, sharedSteps).map((step) => ({
    action: applyParams(step.action, params),
    ...(step.expected ? { expected: applyParams(step.expected, params) } : {}),
    ...(step.data ? { data: applyParams(step.data, params) } : {}),
  }));
}
