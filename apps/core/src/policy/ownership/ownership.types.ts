/**
 * Суд владения (06:64, 02:74): правка единицы вне её своих путей — сигнал и строка следующего
 * брифа, не отказ (отказ вне копии — у `policy/permit`).
 */

export interface OwnershipDecision {
  verdict: 'inside' | 'outside';
  /** Изменённые файлы вне своих путей, по порядку входа. */
  outside: string[];
  reasons: string[];
}
