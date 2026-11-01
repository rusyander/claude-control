import type { SignalDef } from '../../../observer/observer.types.ts';

/**
 * Замер наблюдателя на библиотеке (этап 8, P33, 06:146): по прогонам стенда — доля ложных на
 * сигнал (сработал на задаче, которая его не ждёт / прогонов всего) против порога каталога и
 * истинные (каждый ожидаемый сигнал вышел на своей задаче). Сигнал, которого нет в каталоге, —
 * всегда нарушение: строку без каталога наблюдатель не судит, а писатель её пишет.
 */

export interface MeasuredRun {
  taskId: string;
  cli: string;
  expected: readonly string[];
  fired: readonly string[];
}

export interface SignalRate {
  signal: string;
  runs: number;
  /** Прогоны, где сигнал вышел, не будучи ожидаемым. */
  falsePositives: number;
  fpRate: number;
  fpThreshold: number;
  /** Прогоны, где сигнал ожидаем (без вынесенных за стенд). */
  expectedRuns: number;
  /** Из них — где он вышел. */
  truePositives: number;
}

export interface Miss {
  signal: string;
  taskId: string;
  cli: string;
}

export interface Measurement {
  rows: SignalRate[];
  /** Ложные сверх порога каталога. */
  fpViolations: Miss[];
  /** Ожидаемый сигнал не вышел на своей задаче. */
  tpMisses: Miss[];
  /** Сигнал без строки каталога. */
  unknown: Miss[];
}

/**
 * `outOfHarness` — ожидаемые сигналы, чей писатель стоит вне стенда (форж, команды человека,
 * хуки человека): их истинность доказывает самопроверка каталога, здесь они не ждутся. Ложные по
 * ним считаются как у всех.
 */
export function measure(
  runs: readonly MeasuredRun[],
  catalog: readonly SignalDef[],
  outOfHarness: ReadonlySet<string> = new Set(),
): Measurement {
  const known = new Map<string, SignalDef>(catalog.map((d) => [d.id, d]));
  const fpViolations: Miss[] = [];
  const tpMisses: Miss[] = [];
  const unknown: Miss[] = [];
  const rows = catalog.map((def): SignalRate => ({
    signal: def.id,
    runs: runs.length,
    falsePositives: 0,
    fpRate: 0,
    fpThreshold: def.fpThreshold,
    expectedRuns: 0,
    truePositives: 0,
  }));
  const rowOf = new Map(rows.map((r) => [r.signal, r]));
  for (const run of runs) {
    const expected = new Set(run.expected);
    for (const signal of new Set(run.fired)) {
      const where = { signal, taskId: run.taskId, cli: run.cli };
      if (!known.has(signal)) {
        unknown.push(where);
        continue;
      }
      if (!expected.has(signal)) rowOf.get(signal)!.falsePositives += 1;
    }
    for (const signal of expected) {
      if (outOfHarness.has(signal)) continue;
      const row = rowOf.get(signal);
      if (!row) {
        unknown.push({ signal, taskId: run.taskId, cli: run.cli });
        continue;
      }
      row.expectedRuns += 1;
      if (run.fired.includes(signal)) row.truePositives += 1;
      else tpMisses.push({ signal, taskId: run.taskId, cli: run.cli });
    }
  }
  for (const row of rows) {
    row.fpRate = row.runs === 0 ? 0 : row.falsePositives / row.runs;
    if (row.fpRate > row.fpThreshold) {
      for (const run of runs) {
        if (run.fired.includes(row.signal) && !run.expected.includes(row.signal)) {
          fpViolations.push({ signal: row.signal, taskId: run.taskId, cli: run.cli });
        }
      }
    }
  }
  return { rows, fpViolations, tpMisses, unknown };
}

/** Таблица для отчёта — из вывода прогона, никогда рукой. */
export function formatTable(m: Measurement): string {
  const head = '| signal | runs | FP | FP rate | threshold | TP / expected |';
  const rule = '|---|---|---|---|---|---|';
  const body = m.rows.map(
    (r) =>
      `| ${r.signal} | ${r.runs} | ${r.falsePositives} | ${r.fpRate.toFixed(3)} | ${r.fpThreshold} | ${
        r.expectedRuns === 0 ? '—' : `${r.truePositives} / ${r.expectedRuns}`
      } |`,
  );
  return [head, rule, ...body].join('\n');
}
