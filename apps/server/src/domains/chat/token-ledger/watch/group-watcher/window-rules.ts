import { GROUP_WATCH_SEVERITY, type GroupWatch } from '@agentdeck/contracts/group-watch';
import { windowDelta } from '@agentdeck/contracts/limit-share';
import type { LimitRunRecord } from '../../../limit-journal/limit-journal.ts';
import { accountProjection, type LimitPoint } from '../rules.ts';
import { EVENT_HOLD_MS, MINUTE_MS, minutes } from '../rules-util.ts';
import type { RuleHit } from '../watch.types.ts';

/**
 * Окно подписки глазами сторожа групп: R9 — прогноз пятичасового окна (как было),
 * уровни 80/90/95 % любого из двух окон и прогноз недельного; R42 — прогон группы,
 * сдвинувший окно или съевший много токенов. Перенос `agentdeck-watchdog/scripts/lib/
 * window.mjs` (уровни WINDOW, тяжёлый RUN). Чистые функции: журнал лимита читает
 * `limit-journal.ts`, прогон к группе относит сторож.
 */

/** Уровни окна: каждый пройденный — новость, ниже первого — тишина. */
export const WINDOW_LEVELS = [0.8, 0.9, 0.95] as const;
/** Прогноз недельного окна — по всему окну, но не короче стольких часов замеров. */
export const WEEK_BASIS_MS = 6 * 60 * MINUTE_MS;
/** Шаг замера окна: доля приходит целыми процентами — наклон по нижней границе. */
const UTILIZATION_STEP = 0.01;
/**
 * Окно до прогона — самый поздний замер любого прогона не позже начала и свежее стольких
 * минут до него; иначе первый замер самого прогона. Замер часовой давности лежит в прошлом
 * окне, и сброс после него читался как всё новое окно, потраченное одним прогоном (g1 26.10:
 * «+49 %» при 46 → 49 %). Замер соседа ПОСЛЕ начала — уже середина этого прогона: группы идут
 * вместе, и опора на конец соседа обрезала сдвиг до хвоста (g1 27.10: «+1 %» при 9 → 20 %,
 * g5 «+0 %» при 9 → 22 %).
 */
export const RUN_BASE_RECENT_MS = 15 * MINUTE_MS;

type RunSample = LimitRunRecord['samples'][number];

function runBase(run: LimitRunRecord, pool: readonly RunSample[]): RunSample | undefined {
  let best: RunSample | undefined;
  for (const sample of pool) {
    if (sample.at > run.startedAt || sample.at < run.startedAt - RUN_BASE_RECENT_MS) continue;
    if (!best || sample.at > best.at) best = sample;
  }
  return best ?? (run.samples.length > 1 ? run.samples[0] : undefined);
}

const pct = (share: number): number => Math.round(share * 100);
const hours = (ms: number): number => Math.round(ms / (60 * MINUTE_MS));
const tenths = (share: number | undefined): number => Math.round((share ?? 0) * 1000) / 10;

/** Последний замер окна, чей сброс ещё впереди: замер прошлого окна — история, не уровень. */
function liveLatest(points: readonly LimitPoint[], now: number): LimitPoint | undefined {
  let latest: LimitPoint | undefined;
  for (const point of points) {
    if (point.t > now) continue;
    if (!latest || point.t >= latest.t) latest = point;
  }
  return latest && latest.resetsAt * 1000 > now ? latest : undefined;
}

/**
 * Пройденный уровень окна: самый высокий из двух окон (равные — пятичасовое). Держится,
 * пока окно не сбросилось, и растёт на месте, когда пройден следующий уровень.
 */
export function windowLevel(samples: readonly LimitPoint[], now: number): RuleHit | undefined {
  let best: { point: LimitPoint; level: number } | undefined;
  for (const week of [false, true]) {
    const point = liveLatest(
      samples.filter((one) => Boolean(one.week) === week),
      now,
    );
    if (!point) continue;
    const level = WINDOW_LEVELS.filter((value) => point.utilization >= value).at(-1);
    if (level !== undefined && (!best || level > best.level)) best = { point, level };
  }
  if (!best) return undefined;
  const { point, level } = best;
  const resetMs = point.resetsAt * 1000 - now;
  return {
    rule: 'R9',
    // Уровни — перенос внешнего сторожа (F5): сведением, Telegram получает только прогноз.
    severity: 'info',
    numbers: {
      nowPct: pct(point.utilization),
      levelPct: pct(level),
      ...(point.week ? { resetHours: hours(resetMs) } : { resetMin: minutes(resetMs) }),
    },
    since: point.t,
    textKey: point.week ? 'groupWatch.rule.R9levelWeek' : 'groupWatch.rule.R9level',
  };
}

/**
 * Прогноз недельного окна к сбросу: наклон по всем замерам текущего окна (не короче
 * `WEEK_BASIS_MS`) — получасовой наклон, растянутый на дни, был бы шумом.
 */
export function weekProjection(
  samples: readonly LimitPoint[],
  settings: GroupWatch,
  now: number,
): RuleHit | undefined {
  const week = samples.filter((point) => point.week);
  const latest = liveLatest(week, now);
  if (!latest) return undefined;
  const points = week.filter((point) => point.t <= now && point.resetsAt === latest.resetsAt);
  const first = points.reduce<LimitPoint | undefined>(
    (min, point) => (!min || point.t < min.t ? point : min),
    undefined,
  );
  if (!first || latest.t - first.t < WEEK_BASIS_MS) return undefined;
  const slope = (latest.utilization - first.utilization - UTILIZATION_STEP) / (latest.t - first.t);
  if (slope <= 0) return undefined;
  const resetMs = latest.resetsAt * 1000;
  const projected = latest.utilization + slope * Math.max(0, resetMs - latest.t);
  if (projected * 100 <= settings.projectionPercent) return undefined;
  return {
    rule: 'R9',
    severity: 'info',
    numbers: {
      projectedPct: pct(projected),
      nowPct: pct(latest.utilization),
      resetHours: hours(resetMs - now),
    },
    since: first.t,
    textKey: 'groupWatch.rule.R9week',
  };
}

/**
 * R9 аккаунта — один сигнал: прогноз пятичасового окна (то, что зовёт человека, —
 * «внимание»), иначе пройденный уровень, иначе прогноз недели. Прогноз уже называет
 * нынешнюю загрузку, так что уровень под ним не теряется.
 */
export function accountWindow(
  samples: readonly LimitPoint[],
  settings: GroupWatch,
  now: number,
): RuleHit | undefined {
  return (
    accountProjection(samples, settings, now) ??
    windowLevel(samples, now) ??
    weekProjection(samples, settings, now)
  );
}

/** Законченный прогон (R42, R46): сколько сдвинул окна (доли, нет замеров — нет числа) и токены. */
export interface FinishedRun {
  id: string;
  chatId: string;
  sessionId?: string;
  startedAt: number;
  endedAt: number;
  tokens: number;
  five?: number;
  seven?: number;
}

/** Тяжёлый прогон (R42) — законченный, перешедший один из порогов. */
export type HeavyRun = FinishedRun;

/**
 * Тяжёлый — сдвинул пятичасовое окно на `heavyRunPercent`, недельное на
 * `heavyRunWeekPercent` или съел `heavyRunTokens`.
 */
export function isHeavyRun(run: FinishedRun, settings: GroupWatch): boolean {
  // Доли — до десятой процента: 0,32 − 0,30 в двоичной дроби даёт 1,9999… и ступень порога терялась.
  return (
    tenths(run.five) >= settings.heavyRunPercent ||
    tenths(run.seven) >= settings.heavyRunWeekPercent ||
    run.tokens >= settings.heavyRunTokens
  );
}

/** Законченные прогоны аккаунта, сдвинувшие окно или съевшие много токенов (R42). */
export function heavyRuns(
  runs: readonly LimitRunRecord[],
  settings: GroupWatch,
  now: number,
): HeavyRun[] {
  return finishedRuns(runs, now).filter((run) => isHeavyRun(run, settings));
}

/**
 * Законченные прогоны аккаунта, кончившиеся не раньше `EVENT_HOLD_MS` назад, со сдвигом
 * окон за время прогона. Группы идут вместе: сдвиг — верхняя граница доли прогона.
 * Запись посреди прогона (`open`) — замер, не конец.
 */
export function finishedRuns(runs: readonly LimitRunRecord[], now: number): FinishedRun[] {
  const out: FinishedRun[] = [];
  const pool = runs.flatMap((run) => run.samples);
  const ordered = runs
    .filter((run) => Number.isFinite(run.endedAt))
    .sort((left, right) => left.endedAt - right.endedAt);
  for (const run of ordered) {
    if (run.open || run.endedAt > now || now - run.endedAt > EVENT_HOLD_MS) continue;
    const last = run.samples.at(-1);
    const from = runBase(run, pool);
    const five =
      from?.fiveHour && last?.fiveHour ? windowDelta(from.fiveHour, last.fiveHour) : undefined;
    const seven =
      from?.sevenDay && last?.sevenDay ? windowDelta(from.sevenDay, last.sevenDay) : undefined;
    out.push({
      id: run.id,
      chatId: run.chatId,
      ...(run.sessionId ? { sessionId: run.sessionId } : {}),
      startedAt: run.startedAt,
      endedAt: run.endedAt,
      tokens: run.tokens,
      ...(five !== undefined ? { five } : {}),
      ...(seven !== undefined ? { seven } : {}),
    });
  }
  return out;
}

/**
 * R42 группы: последний её тяжёлый прогон, со счётом таких за полчаса. Окно не мерилось
 * (замеров нет) — строка только о токенах, а не «+0 %».
 */
export function heavyRunHit(list: readonly HeavyRun[]): RuleHit | undefined {
  const last = list.reduce<HeavyRun | undefined>(
    (max, run) => (!max || run.endedAt > max.endedAt ? run : max),
    undefined,
  );
  if (!last) return undefined;
  const measured = last.five !== undefined || last.seven !== undefined;
  return {
    rule: 'R42',
    severity: GROUP_WATCH_SEVERITY.R42,
    numbers: {
      runs: list.length,
      mTokens: Math.round(last.tokens / 100_000) / 10,
      runMin: Math.max(1, minutes(last.endedAt - last.startedAt)),
      ...(measured ? { fivePct: pct(last.five ?? 0), weekPct: pct(last.seven ?? 0) } : {}),
    },
    since: last.endedAt,
    textKey: measured ? 'groupWatch.rule.R42' : 'groupWatch.rule.R42tokens',
  };
}
