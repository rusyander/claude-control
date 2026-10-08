import type { ProjectTestRunRecord } from '@agentdeck/contracts';

/** Счёт строки истории: что пройдено, что брошено и чем кончился прогон. */
export interface RunTally {
  passed: number;
  failed: number;
  skipped: number;
  blocked: number;
  /** Задуманные проходы без результата: «Завершить» при непройденных. */
  open: number;
  /** Не завершён штатно — пометка рядом с режимом; завершённый без неё. */
  state?: 'running' | 'stopped' | 'error';
  /**
   * Есть ли у записи счёт кейсов. Генерация, автоматизация и поиск без
   * найденного кейсы не проходят — нули у них не итог, а отсутствие итога.
   */
  counted: boolean;
}

/** Режимы, которые проходят кейсы: у них и нулевой счёт — итог. */
export const PASSING_MODES: ReadonlySet<string> = new Set(['run', 'manual', 'import']);

/**
 * Строка прогона словами.
 *
 * Блокировка отдельно от пропуска: «пропущено» значит «решили не проверять», а
 * блокировка — «проверить не дали», и сложенные вместе они прятали вторую.
 * Прерванный и идущий прогоны помечены: без пометки брошенный проход выглядел
 * завершённым. Непройденное считается по плану прогона, а не выдумывается.
 */
export function runTally(record: ProjectTestRunRecord): RunTally {
  const { passed, failed, skipped, blocked, total } = record.summary;
  return {
    passed,
    failed,
    skipped,
    blocked,
    open: Math.max(0, (record.planned ?? total) - total),
    state: record.status === 'done' ? undefined : record.status,
    counted: total > 0 || PASSING_MODES.has(record.mode),
  };
}
