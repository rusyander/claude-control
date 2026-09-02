import type {
  Analytics,
  DailyUsage,
  HourlyActivity,
  ModelUsage,
  ProjectUsage,
  ToolUsage,
} from '@claude-control/contracts';
import { localDay, shortenProject } from './keys.ts';
import { emptyTotals } from './totals.ts';
import type { Accumulator, ScanOptions } from './types.ts';

/** Начало местных суток для даты `YYYY-MM-DD`. */
function dayStart(date: string): number {
  const [year, month, day] = date.split('-').map(Number);
  return new Date(year!, month! - 1, day!).getTime();
}

/**
 * Дни без записей входят в ряд нулями. График по дням рисует точки подряд, и
 * без нулей выходные между двумя рабочими днями выглядели бы ровной полкой
 * расхода. Явно заданный период (`anchored`) заполняется от своего начала —
 * «7 дней» = семь точек; скользящее окно от `days` (в том числе «за всё
 * время») — от первого дня с данными, а не сто лет нулей. Без данных ряд пуст.
 */
function fillDays(
  byDay: DailyUsage[],
  since: number,
  until: number,
  anchored: boolean,
): DailyUsage[] {
  const first = byDay[0];
  if (!first) return byDay;
  const known = new Map(byDay.map((day) => [day.date, day]));
  const cursor = new Date(anchored ? since : dayStart(first.date));
  cursor.setHours(0, 0, 0, 0);
  const end = new Date(Math.min(until, Date.now()));
  end.setHours(0, 0, 0, 0);

  const rows: DailyUsage[] = [];
  for (; cursor.getTime() <= end.getTime(); cursor.setDate(cursor.getDate() + 1)) {
    const date = localDay(cursor.toISOString());
    rows.push(known.get(date) ?? { date, totals: emptyTotals(), estimatedCost: 0 });
  }
  // Записи позже `until` в ряд не попадают, а данные — есть: ряд не короче данных.
  return rows.length >= byDay.length ? rows : byDay;
}

/** Накопленные разрезы → готовый отчёт: сортировка, отсечки и производные числа. */
export function buildResult(
  acc: Accumulator,
  options: ScanOptions,
  scannedFiles: number,
  scanDurationMs: number,
  since: number,
  until: number,
): Omit<Analytics, 'runningAgents' | 'topSkills'> {
  const byModel: ModelUsage[] = [...acc.byModel.entries()]
    .map(([model, bucket]) => ({ model, totals: bucket.totals, estimatedCost: bucket.cost }))
    .sort((a, b) => b.totals.total - a.totals.total);

  const byDay = fillDays(
    [...acc.byDay.entries()]
      .map(([date, bucket]) => ({ date, totals: bucket.totals, estimatedCost: bucket.cost }))
      .sort((a, b) => a.date.localeCompare(b.date)),
    since,
    until,
    options.since !== undefined && Number.isFinite(options.since),
  );

  const byProject: ProjectUsage[] = [...acc.byProject.entries()]
    .map(([project, bucket]) => ({
      project,
      displayName: shortenProject(project),
      totals: bucket.totals,
      estimatedCost: bucket.cost,
      sessions: bucket.sessions.size,
      lastActivity: bucket.lastActivity,
    }))
    .sort((a, b) => b.totals.total - a.totals.total);

  const byHour: HourlyActivity[] = Array.from({ length: 24 }, (_, hour) => ({
    hour,
    requests: acc.byHour.get(hour)?.requests ?? 0,
    tokens: acc.byHour.get(hour)?.tokens ?? 0,
  }));

  const recentSessions = [...acc.sessions.values()]
    .sort((a, b) => b.lastActivity.localeCompare(a.lastActivity))
    .slice(0, options.recentSessionsLimit);

  const topTools: ToolUsage[] = [...acc.tools.entries()]
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 20);

  const cacheableInput = acc.overall.cacheRead + acc.overall.cacheCreation;

  return {
    from: new Date(since).toISOString(),
    // Правая граница честно повторяет запрошенную: у диапазона в прошлом «до» —
    // не «сейчас», и отчёт не должен утверждать обратное.
    to: new Date(Math.min(until, Date.now())).toISOString(),
    overall: acc.overall,
    estimatedCost: acc.cost,
    byModel,
    byDay,
    byProject,
    byHour,
    recentSessions,
    topTools,
    activeSessions: [...acc.sessions.values()].filter((session) => session.isActive).length,
    scannedFiles,
    scanDurationMs,
    cacheHitRatio: cacheableInput > 0 ? acc.overall.cacheRead / cacheableInput : 0,
  };
}
