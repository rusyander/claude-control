import type { PlatformSpendDay, PlatformStatus } from '@agentdeck/contracts';

export const NO_SPEND: PlatformSpendDay = {
  day: '',
  requests: 0,
  promptTokens: 0,
  completionTokens: 0,
  totalTokens: 0,
  money: { usd: 0, pricedTokens: 0, unpricedTokens: 0, unpricedModels: [] },
};

export function platformSpendOf(status: PlatformStatus): PlatformSpendDay {
  return (status.periodSpend as PlatformSpendDay | undefined) ?? NO_SPEND;
}
