import type { UsageLimits, UsageLimitWindow } from '@agentdeck/contracts';
import type { UsageLimitsTexts } from '../../shared/config/i18n/usage-limits/ru';

/** Тон окна: от трёх четвертей — предупреждение, от девяноста — опасность (как в панели). */
export type LimitTone = 'normal' | 'warning' | 'danger';

export function limitTone(percent: number): LimitTone {
  if (percent >= 90) return 'danger';
  if (percent >= 75) return 'warning';
  return 'normal';
}

/**
 * Окна для полосы: сессия и неделя целиком. Неделя одной модели — только когда
 * она сейчас ограничивает (`active`): иначе на узком экране она теснит главное.
 */
export function stripWindows(limits: UsageLimits | undefined): UsageLimitWindow[] {
  if (!limits) return [];
  const order = { session: 0, weekly: 1, 'weekly-model': 2 } as const;
  return limits.windows
    .filter((window) => window.kind !== 'weekly-model' || window.active)
    .sort((a, b) => order[a.kind] - order[b.kind]);
}

/** Процент без дописанной точности: сервер отдаёт целые — «41%», дробное — до десятых. */
export function formatPercent(percent: number): string {
  return `${Math.round(percent * 10) / 10}%`;
}

export function windowLabel(window: UsageLimitWindow, t: UsageLimitsTexts): string {
  if (window.kind === 'session') return t.session;
  if (window.kind === 'weekly') return t.weekly;
  return t.weeklyModel(window.model ?? '');
}

/** Сколько до сброса: «1 ч 35 м», «4 д 3 ч», «12 м»; прошедший сброс — «сейчас». */
export function formatUntil(ms: number, t: UsageLimitsTexts): string {
  const minutes = Math.floor(Math.max(0, ms) / 60_000);
  if (minutes < 1) return t.untilSoon;
  if (minutes < 60) return t.untilMinutes(minutes);
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return t.untilHours(hours, minutes % 60);
  return t.untilDays(Math.floor(hours / 24), hours % 24);
}
