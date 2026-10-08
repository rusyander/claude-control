import type { ProviderCheckResult } from '@agentdeck/contracts';

/** Сколько шагов прошло из тех, что вообще выполнялись (пропущенные не в счёт). */
export function checkScore(check: ProviderCheckResult): { passed: number; total: number } {
  const executed = check.steps.filter((step) => step.status !== 'skipped');
  return {
    passed: executed.filter((step) => step.status === 'pass').length,
    total: executed.length,
  };
}
