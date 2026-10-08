import type { ProjectTestStepResult, ProjectTestStatus } from '@agentdeck/contracts';

/** Отметка по шагу: строка либо дописывается, либо заводится со статусом «нет». */
export function patchStepResult(
  results: ProjectTestStepResult[],
  index: number,
  part: Partial<ProjectTestStepResult>,
): ProjectTestStepResult[] {
  const found = results.find((item) => item.index === index);
  if (found) {
    return results.map((item) => (item.index === index ? { ...item, ...part } : item));
  }
  return [...results, { index, status: 'unknown' as ProjectTestStatus, ...part }];
}
