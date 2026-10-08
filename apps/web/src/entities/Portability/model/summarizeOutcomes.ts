import type { EmitEntry, EmitOutcome } from '@agentdeck/contracts/portable-emit';
import { emitOutcomes } from '@agentdeck/contracts/portable-emit';

/**
 * Сколько записей у каждого исхода. Считается ИЗ строк, а не берётся полем
 * ответа: число, за которым на экране нет строк, — то же самое число без
 * основания (правило отчёта верности, оно же здесь).
 */
export function summarizeOutcomes(entries: readonly EmitEntry[]): Record<EmitOutcome, number> {
  const counts = Object.fromEntries(emitOutcomes.map((outcome) => [outcome, 0])) as Record<
    EmitOutcome,
    number
  >;
  for (const entry of entries) counts[entry.outcome] += 1;
  return counts;
}
