import type { ProjectTestStepResult, ProjectTestStatus } from '@agentdeck/contracts';

/**
 * Отметки шагов из записанного результата — по НОМЕРУ шага, а не по месту в
 * массиве: сохраняются только отмеченные шаги (`{ index, status }`), и красная
 * отметка третьего шага при возврате иначе переезжала на первый.
 */
export function restoreStepStatuses(
  count: number,
  saved: ProjectTestStepResult[] | undefined,
): ProjectTestStatus[] {
  return Array.from(
    { length: count },
    (_, at) => saved?.find((item) => item.index === at)?.status ?? 'unknown',
  );
}
