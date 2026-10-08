import type { PlatformStatus } from '@agentdeck/contracts';

/**
 * Доля бюджета в процентах, целыми. Панель уже удерживает долю в пределах
 * единицы, но телефон читает чужой ответ и не обязан ему верить: 150 % на
 * экране выглядели бы ошибкой счёта, а не превышением.
 */
export function budgetPercent(status: PlatformStatus): number {
  return Math.min(100, Math.max(0, Math.round(status.budget.share * 100)));
}
