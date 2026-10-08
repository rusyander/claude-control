import type {
  SubscriptionRowState,
  SubscriptionRow,
} from '@agentdeck/contracts/portable-subscribe';

/** Сводка строк пересборки: сколько записей в каждом состоянии и сколько удержано. */
export interface RowsSummary {
  readonly counts: Record<SubscriptionRowState, number>;
  /**
   * Записи, которые НЕ поедут, потому что их файл тронут рукой. Считается
   * отдельно от состояний намеренно: «изменилась» и «изменилась, но не поедет» —
   * разные ответы, и сложи мы их в одно число, человек прочитал бы удержанное
   * как записанное (П5.2).
   */
  readonly held: number;
}

/**
 * Сколько записей в каждом состоянии. Считается ИЗ строк, а не берётся полем
 * ответа: число, за которым на экране нет строк, — то же самое число без
 * основания.
 */
export function summarizeRows(rows: readonly SubscriptionRow[]): RowsSummary {
  const counts: Record<SubscriptionRowState, number> = {
    new: 0,
    changed: 0,
    unchanged: 0,
    gone: 0,
  };
  let held = 0;
  for (const row of rows) {
    counts[row.state] += 1;
    if (row.heldBy) held += 1;
  }
  return { counts, held };
}
