import type { ProjectTestRunRecord } from '@agentdeck/contracts';

/** Один столбик тренда в координатах SVG 0…100 по обеим осям. */
export interface TrendBar {
  id: string;
  x: number;
  width: number;
  /** Высота зелёной части, снизу. */
  passed: number;
  /** Высота красной части, поверх зелёной. */
  failed: number;
}

/**
 * Столбики тренда: последние прогоны слева направо во времени.
 *
 * История приходит от новых к старым, а читается наоборот; пустой прогон
 * (`total` = 0) считается за один кейс, иначе деление дало бы бесконечность и
 * столбик исчез бы вместе со всем графиком.
 *
 * Ширина считается не по числу прогонов, а по `minSlots`: на двух прогонах
 * половина ширины карточки на столбик — это уже не график, а две заливки, по
 * которым ничего не прочитать. С пустыми местами справа видно и то, что прогонов
 * пока мало, и то, куда они добавятся.
 */
export function trendBars(runs: ProjectTestRunRecord[], limit = 30, minSlots = 12): TrendBar[] {
  const items = [...runs].reverse().slice(-limit);
  if (items.length === 0) return [];

  const step = 100 / Math.max(items.length, minSlots);
  const width = Math.max(step * 0.6, 1);

  return items.map((run, index) => {
    const total = Math.max(run.summary.total, 1);
    return {
      id: run.id,
      x: index * step + (step - width) / 2,
      width,
      passed: (run.summary.passed / total) * 100,
      failed: (run.summary.failed / total) * 100,
    };
  });
}
