import type { ProjectTestPyramid, ProjectTestPyramidCount } from '@agentdeck/contracts';

export type PyramidLayer = 'e2e' | 'integration' | 'unit' | 'code';

/**
 * Строки пирамиды сверху вниз, как у панели: e2e, затем интеграционные и
 * модульные, если проект их помечает, иначе одна строка «тесты кода». Слой без
 * счёта остаётся строкой со словом «не известно» — пропуск читался бы как ноль.
 */
export function pyramidRows(
  data: ProjectTestPyramid,
): { layer: PyramidLayer; count?: ProjectTestPyramidCount }[] {
  const e2e = { layer: 'e2e' as const, count: data.e2e };
  if (data.split) {
    return [
      e2e,
      { layer: 'integration', count: data.integration },
      { layer: 'unit', count: data.unit },
    ];
  }
  return [e2e, { layer: 'code', count: data.code }];
}
