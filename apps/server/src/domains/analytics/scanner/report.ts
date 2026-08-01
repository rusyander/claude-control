import type {
  Analytics,
  DailyUsage,
  HourlyActivity,
  ModelUsage,
  ProjectUsage,
  ToolUsage,
} from '@claude-control/contracts';
import { shortenProject } from './keys.ts';
import type { Accumulator, ScanOptions } from './types.ts';

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

  const byDay: DailyUsage[] = [...acc.byDay.entries()]
    .map(([date, bucket]) => ({ date, totals: bucket.totals, estimatedCost: bucket.cost }))
    .sort((a, b) => a.date.localeCompare(b.date));

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
