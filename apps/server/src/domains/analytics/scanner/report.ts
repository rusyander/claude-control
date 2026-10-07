import type {
  Analytics,
  DailyUsage,
  HourlyActivity,
  ModelUsage,
  ProjectUsage,
  SessionUsage,
  ToolUsage,
} from '@agentdeck/contracts';
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

/** Сколько инструментов сессии показывать: список для строки, а не для отчёта. */
const SESSION_TOOLS_LIMIT = 5;

/** Сколько последних сессий класть в каждый проект. */
const PROJECT_SESSIONS_LIMIT = 10;

/**
 * Сессия для отчёта: к итогам, посчитанным по ходу обхода, добавляются
 * заголовок и инструменты. Копия, а не правка: одна и та же сессия попадает и в
 * общий список последних, и в список своего проекта.
 */
function describeSession(session: SessionUsage, acc: Accumulator): SessionUsage {
  const tools = acc.sessionTools.get(session.sessionId);
  const title = acc.sessionTitles.get(session.sessionId);
  const own = [...(tools ?? [])]
    .map(([name, count]) => ({ name, count }))
    // При равенстве — по имени: порядок не должен зависеть от порядка строк в файле.
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));

  return {
    ...session,
    ...(title ? { title } : {}),
    ...(own.length > 0
      ? {
          toolCalls: own.reduce((sum, tool) => sum + tool.count, 0),
          topTools: own.slice(0, SESSION_TOOLS_LIMIT),
        }
      : {}),
  };
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

  const newestFirst = [...acc.sessions.values()].sort((a, b) =>
    b.lastActivity.localeCompare(a.lastActivity),
  );
  const sessionsByProject = new Map<string, SessionUsage[]>();
  for (const session of newestFirst) {
    const own = sessionsByProject.get(session.project) ?? [];
    if (own.length < PROJECT_SESSIONS_LIMIT) own.push(describeSession(session, acc));
    sessionsByProject.set(session.project, own);
  }

  const byProject: ProjectUsage[] = [...acc.byProject.entries()]
    .map(([project, bucket]) => ({
      project,
      displayName: shortenProject(project),
      totals: bucket.totals,
      estimatedCost: bucket.cost,
      sessions: bucket.sessions.size,
      lastActivity: bucket.lastActivity,
      sessionList: sessionsByProject.get(project) ?? [],
    }))
    .sort((a, b) => b.totals.total - a.totals.total);

  const byHour: HourlyActivity[] = Array.from({ length: 24 }, (_, hour) => ({
    hour,
    requests: acc.byHour.get(hour)?.requests ?? 0,
    tokens: acc.byHour.get(hour)?.tokens ?? 0,
  }));

  const recentSessions = newestFirst
    .slice(0, options.recentSessionsLimit)
    .map((session) => describeSession(session, acc));

  const topTools: ToolUsage[] = [...acc.tools.entries()]
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 20);

  // Claude пишет кэш явно, и доля — чтение против записи. Codex и Qwen запись не
  // сообщают (кэш у OpenAI-формы неявный), и та же формула давала бы 100% при
  // любом чтении — у них доля считается от всего входа.
  const cacheableInput = options.source
    ? acc.overall.input + acc.overall.cacheRead + acc.overall.cacheCreation
    : acc.overall.cacheRead + acc.overall.cacheCreation;

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
    periodSessions: acc.sessions.size,
    topTools,
    activeSessions: [...acc.sessions.values()].filter((session) => session.isActive).length,
    scannedFiles,
    scanDurationMs,
    cacheHitRatio: cacheableInput > 0 ? acc.overall.cacheRead / cacheableInput : 0,
    ...(options.source ? { providerId: options.source.kind } : {}),
    ...(acc.unpriced.size > 0 ? { unpricedModels: [...acc.unpriced].sort() } : {}),
  };
}
