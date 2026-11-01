import type { OutcomeRule } from '../sdk-stream/outcome.ts';

/** Строка рамки `run_shell_command` с pid группы процесса — новая при каждом вызове. */
const PGID_LINE = 'Process Group PGID:';

/**
 * Исход вызова у Qwen Code 0.24.3 (проба этапа 8): поток несёт подпись для показа (`read_file` →
 * «Read lines 11-15 of 400 from big.txt»), а не то, что получила модель, — размера нет. Рамка
 * упавшей команды кончается строкой pid группы процесса: без её снятия один и тот же сбой давал
 * бы каждый раз другой отпечаток.
 */
export const QWEN_OUTCOME: OutcomeRule = {
  contentIsPayload: false,
  volatileLine: (line) => line.startsWith(PGID_LINE),
};
