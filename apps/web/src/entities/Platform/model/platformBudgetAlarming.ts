import type { PlatformBudgetState } from '@agentdeck/contracts';

/**
 * Тревожен ли бюджет контура.
 *
 * Своего счёта у клиента больше НЕТ: бюджет считает сервер по постоянному учёту
 * (`PlatformStatus.budget`), потому что счётчик живого шлюза обнуляется вместе с
 * процессом — после перезапуска панели карточка сообщала бы «потрачено $0»
 * ключу, который уже упёрся в бюджет. Здесь остаётся только правило показа:
 * отказ контура (402) тревожен всегда, наша оценка — когда она дошла до
 * введённой цифры.
 */
export function platformBudgetAlarming(budget: PlatformBudgetState): boolean {
  return budget.exhausted || budget.overEstimate;
}
