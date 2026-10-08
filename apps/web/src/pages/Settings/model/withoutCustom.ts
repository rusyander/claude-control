import type { ModelPricing } from '@agentdeck/contracts';

/** Свои цены без одной записи. */
export function withoutCustom(
  custom: Record<string, ModelPricing>,
  key: string,
): Record<string, ModelPricing> {
  return Object.fromEntries(Object.entries(custom).filter(([fragment]) => fragment !== key));
}
