import type { TFunction } from 'i18next';
import type { UsageLimitWindow } from '@agentdeck/contracts';

/** Подпись окна: «Сессия (5 ч)», «Неделя», «Неделя · Opus». */
export function windowLabel(window: UsageLimitWindow, t: TFunction): string {
  if (window.kind === 'session') return t('usageLimits.session');
  if (window.kind === 'weekly') return t('usageLimits.weekly');
  return t('usageLimits.weeklyModel', { model: window.model ?? '' });
}
