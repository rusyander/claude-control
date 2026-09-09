import type { SplitPlan } from '@agentdeck/contracts/split-plan';

export interface TriageCardProps {
  /**
   * Разбор, как его прочла лента: группы по номерам, без названий — предложения
   * рядом с чатом разбора нет, а номера те же, что в его задании.
   */
  plan: SplitPlan;
}
