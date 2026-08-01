import type { TokenTotals } from '@claude-control/contracts';
import type { RawUsage } from './types.ts';

/** Арифметика токенов: пустые итоги, накопление одной записи, разрез по ключу. */

/**
 * Общий объём записи кэша. Плоское поле — основное; разбивка суммируется
 * только когда его нет, иначе объём разошёлся бы со стоимостью.
 */
export function cacheCreationTokens(usage: RawUsage): number {
  if (usage.cache_creation_input_tokens !== undefined) return usage.cache_creation_input_tokens;
  const split = usage.cache_creation;
  return (split?.ephemeral_5m_input_tokens ?? 0) + (split?.ephemeral_1h_input_tokens ?? 0);
}

export function emptyTotals(): TokenTotals {
  return { input: 0, output: 0, cacheRead: 0, cacheCreation: 0, total: 0, requests: 0 };
}

export function addUsage(target: TokenTotals, usage: RawUsage): void {
  const input = usage.input_tokens ?? 0;
  const output = usage.output_tokens ?? 0;
  const cacheRead = usage.cache_read_input_tokens ?? 0;
  const cacheCreation = cacheCreationTokens(usage);

  target.input += input;
  target.output += output;
  target.cacheRead += cacheRead;
  target.cacheCreation += cacheCreation;
  target.total += input + output + cacheRead + cacheCreation;
  target.requests += 1;
}

export function upsert(
  map: Map<string, { totals: TokenTotals; cost: number }>,
  key: string,
  usage: RawUsage,
  cost: number,
): void {
  const bucket = map.get(key) ?? { totals: emptyTotals(), cost: 0 };
  addUsage(bucket.totals, usage);
  bucket.cost += cost;
  map.set(key, bucket);
}
