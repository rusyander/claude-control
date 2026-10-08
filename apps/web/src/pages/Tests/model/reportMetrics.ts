import type { ProjectTestReport } from '@agentdeck/contracts';

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
