import type {
  ProjectTestReport,
  ProjectTestRunRecord,
  ProjectTestStatus,
} from '@agentdeck/contracts';

/**
 * Счёт для отчёта: доли, геометрия тренда и длительности.
 *
 * Держится отдельно от разметки, потому что это единственное место раздела, где
 * из чисел сервера получаются другие числа: ошибка здесь не видна ни в одном
 * типе и вылезает только «график нарисован не тот». Разметке остаётся расставить
 * прямоугольники по готовым координатам.
 */

export interface StatusTotals {
  total: number;
  passed: number;
  failed: number;
  unknown: number;
}

/** Суммарная раскладка по статусам: она же складывается из зон. */
export function statusTotals(report: ProjectTestReport): StatusTotals {
  return report.areas.reduce<StatusTotals>(
    (sum, area) => ({
      total: sum.total + area.total,
      passed: sum.passed + area.passed,
      failed: sum.failed + area.failed,
      unknown: sum.unknown + area.unknown,
    }),
    { total: 0, passed: 0, failed: 0, unknown: 0 },
  );
}

/** Сколько всего кейсов в раскладке по автоматизации — знаменатель её полосы. */
export function automationTotal(report: ProjectTestReport): number {
  const { manual, toAutomate, automated } = report.automation;
  return manual + toAutomate + automated;
}

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

/**
 * Кейсы прогона, которые надо перепрогнать: провалы и блокировки.
 *
 * Блокировка тут наравне с провалом: и то и другое означает «результата нет».
 * Кейс попадает в список один раз, сколько бы точек у него ни было, — иначе
 * «перепрогнать провалившиеся» запустило бы один и тот же кейс дважды.
 */
export function redCases(record: ProjectTestRunRecord | undefined): string[] {
  const ids = (record?.results ?? [])
    .filter((item) => isRed(item.status))
    .map((item) => item.caseId);
  return [...new Set(ids)];
}

/** Красное: провал и блокировка. Оба означают «результата нет». */
export function isRed(status: ProjectTestStatus): boolean {
  return status === 'failed' || status === 'blocked';
}

/** Длительность прогона словами: незакрытый прогон длительности ещё не имеет. */
export function formatRunDuration(startedAt: string, finishedAt?: string): string {
  if (!finishedAt) return '—';
  const ms = new Date(finishedAt).getTime() - new Date(startedAt).getTime();
  if (!Number.isFinite(ms) || ms < 0) return '—';
  const minutes = Math.floor(ms / 60000);
  const seconds = Math.floor((ms % 60000) / 1000);
  return minutes > 0 ? `${minutes} мин ${seconds} с` : `${seconds} с`;
}
