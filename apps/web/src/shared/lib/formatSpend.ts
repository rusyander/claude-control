import { formatTokens } from './formatTokens';

/**
 * Расход в выбранных единицах: токены (по умолчанию) или деньги. Так пользователь
 * видит именно то, что ему привычнее, а второе можно включить в настройках.
 */
export function formatSpend(unit: 'tokens' | 'money', tokens: number, costUsd: number): string {
  return unit === 'money' ? `$${costUsd.toFixed(3)}` : `${formatTokens(tokens)} tok`;
}
