import type { UsageLimitWindow } from '@agentdeck/contracts';
import type { LimitWindowSample } from '@agentdeck/contracts/limit-share';
import { readLimitRuns } from '../chat/limit-journal/limit-journal.ts';

/**
 * Запасной источник: последний замер окон из прогона чата (`rate_limit_event`
 * потока CLI, журнал `limit-runs.json`). Берётся, только когда ответа сервера
 * нет (токен истёк, сеть, 429): тот же сервер Anthropic, но увиденный глазами
 * последнего прогона, поэтому со своим моментом замера.
 *
 * Точность здесь — доля 0..1 с двумя знаками (`0.68`), т. е. целые проценты.
 * Окно, чей сброс уже прошёл, не показывается: после сброса загрузка неизвестна.
 */
export function latestJournalWindows(
  appDataDir: string,
  now: number,
): { at: number; windows: UsageLimitWindow[] } | undefined {
  let best: { at: number; fiveHour?: LimitWindowSample; sevenDay?: LimitWindowSample } | undefined;
  for (const run of readLimitRuns(appDataDir)) {
    for (const sample of run.samples) {
      if (typeof sample?.at === 'number' && (!best || sample.at > best.at)) best = sample;
    }
  }
  if (!best) return undefined;
  const windows: UsageLimitWindow[] = [];
  const push = (id: 'session' | 'weekly', sample: LimitWindowSample | undefined): void => {
    if (!sample || sample.resetsAt * 1000 <= now) return;
    windows.push({
      id,
      kind: id,
      percent: Math.round(sample.utilization * 100 * 1000) / 1000,
      resetsAt: sample.resetsAt * 1000,
    });
  };
  push('session', best.fiveHour);
  push('weekly', best.sevenDay);
  return windows.length > 0 ? { at: best.at, windows } : undefined;
}
