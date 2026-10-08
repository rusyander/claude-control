import type { PlatformStatus } from '@agentdeck/contracts';

/** Строка отказа 402 по тому, что назвал манифест драйвера. */
export function exhaustedTextKey(budget: PlatformStatus['budget']) {
  if (budget.exhaustedScope === 'key') return 'platform.budgetExhaustedKey';
  return budget.exhaustedLevel ? 'platform.budgetExhaustedLevel' : 'platform.budgetExhausted';
}
