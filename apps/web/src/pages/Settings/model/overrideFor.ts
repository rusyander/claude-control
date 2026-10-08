import type { ModelPricing } from '@agentdeck/contracts';

/** Своя цена для строки прайса: точное совпадение либо заданный раньше фрагмент. */
export function overrideFor(
  custom: Record<string, ModelPricing>,
  id: string,
): ModelPricing | undefined {
  return Object.entries(custom).find(([fragment]) => id.includes(fragment))?.[1];
}
